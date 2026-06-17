// api/analyze.js — Vercel serverless function
// Receives a screenshot from the extension, calls OpenAI, returns the result.
// Users never need their own API key — we handle it here.
//
// Smart model routing:
//   All questions     → gpt-4o-mini first  (fast, ~$0.001/capture)
//   Low confidence    → retry with gpt-4o  (accurate, ~$0.01/capture)
//   Threshold: any question confidence < 70 triggers the upgrade

import { createClient } from '@supabase/supabase-js';
import { verifyUser, bearerToken } from './_auth.js';
import { FREE_LIMIT, PRO_MONTHLY_LIMIT } from './_config.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SYSTEM_PROMPT = `You are StudySnap, an AI study assistant.

Analyze the screenshot and answer ALL visible UNANSWERED questions in one response.

SOURCE OF TRUTH:
The SCREENSHOT is authoritative — answer every unanswered question you can SEE in the image. Any "extracted page text" provided is only a supplementary hint; it is often incomplete (questions inside iframes are missing) or polluted with unrelated page chrome such as cookie-consent banners and navigation. NEVER decide a page has no questions just because the extracted text doesn't mention them, and NEVER treat cookie/consent checkboxes or navigation as study questions. If the screenshot shows unanswered questions, you MUST answer them.

IDENTIFYING ANSWERED QUESTIONS:
A question is already answered if ANY of its options looks different from the others: colored text (green/red), checkmark ✓, X mark ✗, highlighted background, or any icon. SKIP those entirely — do not include them in your response.

An UNANSWERED question has ALL options looking visually identical (same color, no icons, no highlights).

OUTPUT — respond ONLY with valid JSON (no markdown, no code fences):
{
  "questions": [
    {
      "questionType": "mcq" | "truefalse" | "fillin" | "short" | "writing" | "none",
      "why": "1-2 sentence reasoning for this specific question",
      "answer": "the correct answer — must match what 'why' supports",
      "confidence": 0-100
    }
  ]
}

CRITICAL RULES:
- If the question has visible selectable options (radio buttons, checkboxes, A/B/C choices): "answer" MUST be copied EXACTLY from one of those visible options — even if the question is phrased as fill-in-the-blank. Never invent an answer not shown on screen.
- Only write a free-text answer when there are NO visible options at all.
- Include one entry per unanswered question, in order of appearance.
- If no unanswered questions are visible, return { "questions": [] }.
- The "answer" and "why" fields must always refer to the same question.
- Plain text answers only (no HTML) unless it is a writing/essay assignment.
- MATH AND FORMULAS: Express math using Unicode symbols (×, ÷, ±, √, π, ², ³, ∑, ∫, ≠, ≤, ≥, ∞, θ, Δ) rather than LaTeX (\\frac, \\sqrt) or plain ASCII (^2, x/y). The answer renders as plain text, so Unicode is the best format for readability.`;

// ── OpenAI helper ────────────────────────────────────────────────────────────

async function callOpenAI(model, base64Image, pageText = null) {
  // Build user message: always include screenshot + extracted text when available
  const userContent = [
    {
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${base64Image}`, detail: 'high' },
    },
    {
      type: 'text',
      text: pageText
        ? `Answer ALL unanswered questions you can see in the SCREENSHOT.

The text below is only a hint and may be incomplete or contain unrelated page chrome (cookie banners, navigation). Use it ONLY to detect already-answered questions: any question marked <<QUESTION ALREADY ANSWERED BY USER — SKIP>> should be skipped. Do not rely on this text for the list of questions — rely on the screenshot.

--- Extracted page text (hint only) ---
${pageText}`
        : 'Identify and answer ALL unanswered study questions visible in the screenshot.',
    },
  ];

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      temperature: 0,   // deterministic — always pick the most confident answer
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err?.error?.message ?? `OpenAI ${response.status}`);
  }

  const data  = await response.json();
  const raw   = data.choices?.[0]?.message?.content ?? '';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not parse AI response');
  const parsed = JSON.parse(match[0]);
  // Normalise: API always returns { questions: [...] }
  if (Array.isArray(parsed.questions)) return parsed;
  // Fallback: old single-question format wrapped into array
  return { questions: [parsed] };
}

// ── OpenAI helper — typed text question (no screenshot) ──────────────────────

const TEXT_SYSTEM_PROMPT = `You are StudySnap, an AI study assistant. Answer the student's question clearly and correctly, in the same language as the question.

For math or science questions, use Unicode symbols (×, ÷, ±, √, π, ², ³, ∑, ∫, ≠, ≤, ≥, ∞, θ, Δ) instead of LaTeX or plain ASCII. The answer is displayed as plain text, so Unicode is the best format.

Respond ONLY with valid JSON (no markdown, no code fences):
{
  "questions": [
    {
      "questionType": "short",
      "why": "1-2 sentence reasoning",
      "answer": "the direct answer",
      "confidence": 0-100
    }
  ]
}`;

async function callOpenAIText(model, question) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      temperature: 0,
      messages: [
        { role: 'system', content: TEXT_SYSTEM_PROMPT },
        { role: 'user',   content: question },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err?.error?.message ?? `OpenAI ${response.status}`);
  }

  const data  = await response.json();
  const raw   = data.choices?.[0]?.message?.content ?? '';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not parse AI response');
  const parsed = JSON.parse(match[0]);
  if (Array.isArray(parsed.questions)) return parsed;
  return { questions: [parsed] };
}

// ── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { imageDataUrl, pageText = null, precise = false, question = null } = req.body;
    const textMode = !imageDataUrl && typeof question === 'string' && question.trim().length > 0;
    if (!imageDataUrl && !textMode) return res.status(400).json({ error: 'No image or question provided.' });

    // ── Image size guard (Vercel body limit ≈ 4.5 MB) ────────────────────────
    // base64 is ~4/3 of raw bytes, so a 4 MB base64 string ≈ 3 MB actual image.
    // Reject early with a user-friendly message rather than letting Vercel 413.
    if (imageDataUrl && imageDataUrl.length > 4 * 1024 * 1024) {
      return res.status(413).json({
        error: 'Screenshot is too large. Try zooming out, scrolling to show fewer questions, or use ✂ Select Area to capture a smaller region.',
      });
    }

    // ── Auth: require a verified user — no anonymous captures ───────────────
    const token = bearerToken(req);
    const user  = await verifyUser(token);
    if (!user) {
      return res.status(401).json({ error: 'Sign in to use StudySnap.' });
    }

    // isPro = active Stripe subscription (dormant — always false while Stripe
    // is paused). Ko-fi credits are handled separately below.
    let isPro = false;
    // Uncomment when Stripe is re-enabled:
    // const { data: status } = await supabase.rpc('get_subscription', { p_user_id: user.id });
    // isPro = status === 'active';

    // ── Pro monthly cap ───────────────────────────────────────────────────────
    if (user && isPro) {
      const today      = new Date().toISOString().split('T')[0];
      const monthStart = today.slice(0, 7) + '-01'; // YYYY-MM-01
      const { data: monthlyCount } = await supabase.rpc('get_monthly_usage', {
        p_user_id:    user.id,
        p_month_start: monthStart,
      });
      if ((monthlyCount ?? 0) >= PRO_MONTHLY_LIMIT) {
        const nextMonth = new Date();
        nextMonth.setMonth(nextMonth.getMonth() + 1, 1);
        const resetDate = nextMonth.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
        return res.status(429).json({
          error: `Monthly capture limit reached. Your captures reset on ${resetDate}.`,
          limitReached: true,
        });
      }
    }

    // ── Apply any pending Ko-fi credits ─────────────────────────────────────────
    // Fire-and-forget: must not block the capture if it hangs or fails.
    supabase.rpc('apply_pending_credits', { p_user_id: user.id, p_email: user.email })
      .catch((e) => { console.error('[SS] apply_pending_credits:', e?.message); });

    // ── Free tier limit, then Ko-fi credits ────────────────────────────────────
    // Only CHECK here. We charge *after* a successful AI call so a failed capture
    // never costs a free capture or a credit. Spend order: free daily first, then
    // Ko-fi credits. (Stripe Pro users are unlimited and never reach this block.)
    let useCredit    = false;
    let kofiCredits  = 0; // tracked here so model routing can use it
    if (!isPro) {
      const today = new Date().toISOString().split('T')[0];

      const [{ data: usageCount }, { data: shareBonus }, { data: credits }] = await Promise.all([
        supabase.rpc('get_usage',        { p_user_id: user.id, p_date: today }),
        supabase.rpc('get_bonus',        { p_user_id: user.id, p_date: today }),
        supabase.rpc('get_user_credits', { p_user_id: user.id }),
      ]);

      kofiCredits          = credits     ?? 0;
      const todayCount     = usageCount  ?? 0;
      const effectiveLimit = FREE_LIMIT + (shareBonus ?? 0);

      if (todayCount >= effectiveLimit) {
        // Free allowance used up — fall back to Ko-fi credits if the user has any
        if (kofiCredits <= 0) {
          return res.status(429).json({
            error: `Free limit reached (${effectiveLimit}/day) and no credits left. Get credits on Ko-fi to keep going!`,
            limitReached: true,
          });
        }
        useCredit = true;
      }
    }

    // ── AI call — smart model routing ────────────────────────────────────────
    let result;
    let upgraded = false;

    // Ko-fi credit holders get gpt-4o on region captures (their perk for supporting).
    // Stripe Pro (when re-enabled) gets gpt-4o always.
    const hasKofiCredits = kofiCredits > 0 || useCredit;

    if (textMode) {
      // Typed question (no screenshot). Credit/Pro users get gpt-4o directly;
      // free users start on mini and escalate on low confidence.
      const model = (isPro || hasKofiCredits) ? 'gpt-4o' : 'gpt-4o-mini';
      result = await callOpenAIText(model, question.trim());
      if (!isPro && !hasKofiCredits) {
        const lowConf = (result.questions ?? []).some(q => (q.confidence ?? 100) < 70);
        if (lowConf) { result = await callOpenAIText('gpt-4o', question.trim()); upgraded = true; }
      } else {
        upgraded = true;
      }
    } else if (isPro || (precise && hasKofiCredits)) {
      const base64Image = imageDataUrl.replace(/^data:image\/\w+;base64,/, '');
      // Pro users and Ko-fi credit holders doing region capture get gpt-4o
      result   = await callOpenAI('gpt-4o', base64Image, pageText);
      upgraded = true;
    } else {
      const base64Image = imageDataUrl.replace(/^data:image\/\w+;base64,/, '');
      // Free users: start with mini, upgrade if confidence is low OR if mini found
      // nothing (often a mini miss — e.g. questions in an iframe where the text
      // hint is useless and only the screenshot has them; gpt-4o sees them).
      result = await callOpenAI('gpt-4o-mini', base64Image, pageText);
      const questionCount    = (result.questions ?? []).length;
      const hasLowConfidence = (result.questions ?? []).some(q => (q.confidence ?? 100) < 70);
      if (questionCount === 0 || hasLowConfidence) {
        result   = await callOpenAI('gpt-4o', base64Image, pageText);
        upgraded = true;
      }
    }

    // ── Charge the capture only now that the AI call succeeded ────────────────
    if (user && !isPro) {
      if (useCredit) {
        // Free allowance was exhausted — spend one Ko-fi credit
        const { error: spendErr } = await supabase.rpc('spend_user_credit', { p_user_id: user.id });
        if (spendErr) console.error(`[SS] credit_spend_fail: ${spendErr.message}`);
      } else {
        const today = new Date().toISOString().split('T')[0];
        // Increment daily free usage (SECURITY DEFINER — bypasses permission checks)
        const { error: rpcError } = await supabase.rpc('increment_usage', {
          p_user_id: user.id,
          p_date:    today,
        });
        if (rpcError) console.error(`[SS] rpc_fail: ${rpcError.message}`);
      }
    }

    return res.status(200).json({ ...result, isPro, upgraded, usedCredit: useCredit });

  } catch (err) {
    console.error('[StudySnap API]', err.message);
    return res.status(500).json({ error: err.message || 'Something went wrong — please try again.' });
  }
}
