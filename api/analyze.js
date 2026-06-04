// api/analyze.js — Vercel serverless function
// Receives a screenshot from the extension, calls OpenAI, returns the result.
// Users never need their own API key — we handle it here.
//
// Smart model routing:
//   All questions     → gpt-4o-mini first  (fast, ~$0.001/capture)
//   Low confidence    → retry with gpt-4o  (accurate, ~$0.01/capture)
//   Threshold: any question confidence < 70 triggers the upgrade

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);


const FREE_LIMIT = 5; // captures per day on free tier

// Decode a Supabase-issued JWT without a network call.
// The token is already signed by Supabase so we trust its claims.
function getUserFromToken(token) {
  try {
    const payload = token.split('.')[1];
    const json = Buffer.from(
      payload.replace(/-/g, '+').replace(/_/g, '/'),
      'base64'
    ).toString('utf8');
    const data = JSON.parse(json);
    // Reject expired tokens
    if (data.exp && data.exp < Math.floor(Date.now() / 1000)) return null;
    if (!data.sub) return null;
    return { id: data.sub, email: data.email };
  } catch {
    return null;
  }
}

const SYSTEM_PROMPT = `You are StudySnap, an AI study assistant.

Analyze the screenshot and answer ALL visible UNANSWERED questions in one response.

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
      "deepExplanation": "",
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
- Plain text answers only (no HTML) unless it is a writing/essay assignment.`;

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
        ? `The extracted text below marks answered questions with <<QUESTION ALREADY ANSWERED BY USER — SKIP>>. Skip every question with that marker.

Answer ALL remaining unanswered questions visible in the screenshot.

--- Extracted page text ---
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

// ── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { imageDataUrl, token, pageText = null, precise = false } = req.body;
    if (!imageDataUrl) return res.status(400).json({ error: 'No image provided.' });

    // ── Auth: verify user token ──────────────────────────────────────────────
    let user   = null;
    let isPro  = false;

    if (token) {
      user = getUserFromToken(token);

      if (user) {
        const { data: status } = await supabase.rpc('get_subscription', { p_user_id: user.id });
        isPro = status === 'active';
      }
    }

    // ── Pro monthly cap ───────────────────────────────────────────────────────
    const PRO_MONTHLY_LIMIT = 700;
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

    // ── Free tier limit ───────────────────────────────────────────────────────
    if (user && !isPro) {
      const today = new Date().toISOString().split('T')[0];

      const [{ data: usageCount }, { data: shareBonus }] = await Promise.all([
        supabase.rpc('get_usage', { p_user_id: user.id, p_date: today }),
        supabase.rpc('get_bonus', { p_user_id: user.id, p_date: today }),
      ]);

      const todayCount     = usageCount ?? 0;
      const effectiveLimit = FREE_LIMIT + (shareBonus ?? 0);

      if (todayCount >= effectiveLimit) {
        return res.status(429).json({
          error: `Free limit reached (${effectiveLimit}/day). Upgrade to Pro for unlimited captures.`,
          limitReached: true,
        });
      }

      // Increment via SECURITY DEFINER function — bypasses all permission checks
      const { error: rpcError } = await supabase.rpc('increment_usage', {
        p_user_id: user.id,
        p_date:    today,
      });
      if (rpcError) console.error(`[SS] rpc_fail: ${rpcError.message}`);
    }

    // ── AI call — smart model routing ────────────────────────────────────────
    const base64Image = imageDataUrl.replace(/^data:image\/\w+;base64,/, '');
    let result;
    let upgraded = false;

    if (isPro || precise) {
      // Pro users and region captures always get gpt-4o — best answer every time
      result   = await callOpenAI('gpt-4o', base64Image, pageText);
      upgraded = true;
    } else {
      // Free users: start with mini, upgrade if confidence is low
      result = await callOpenAI('gpt-4o-mini', base64Image, pageText);
      const hasLowConfidence = (result.questions ?? []).some(q => (q.confidence ?? 100) < 70);
      if (hasLowConfidence) {
        result   = await callOpenAI('gpt-4o', base64Image, pageText);
        upgraded = true;
      }
    }

    return res.status(200).json({ ...result, isPro, upgraded });

  } catch (err) {
    console.error('[StudySnap API]', err.message);
    return res.status(500).json({ error: err.message || 'Something went wrong — please try again.' });
  }
}
