// api/analyze.js — Vercel serverless function
// Receives a screenshot from the extension, calls OpenAI, returns the result.
// Users never need their own API key — we handle it here.
//
// Smart model routing:
//   Regular questions → gpt-4o-mini  (~$0.0006/capture, fast)
//   Writing assignments → gpt-4o    (~$0.01/capture, better quality)

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);


const FREE_LIMIT = 10; // captures per day on free tier

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

STEP 1 — FIND THE TARGET QUESTION:
Scan every visible question. A question is ALREADY ANSWERED if ANY of its options shows a visual difference: green/red color, checkmark ✓, X mark ✗, highlighted background, colored text, or any icon. SKIP all answered questions. Your target is the FIRST question where ALL options look identical and unselected (same color, no icons, no highlights).

STEP 2 — ANSWER THE TARGET QUESTION:
Answer only the target question identified in Step 1. Do not answer any question that has any visual indicator on any of its options.

STEP 3 — OUTPUT JSON:
You MUST always respond with valid JSON only — no markdown, no code fences. Fields must appear in this exact order:
{
  "questionType": "mcq" | "truefalse" | "fillin" | "short" | "writing" | "none",
  "why": "explain your reasoning — what is the TARGET question asking, and why is one option correct?",
  "answer": "the correct answer to the TARGET question — must match what your 'why' supports",
  "deepExplanation": "...",
  "confidence": 0-100
}

If no unanswered question is visible, use questionType "none", answer "No unanswered question detected.", why "", deepExplanation "", confidence 0.

If no study question is visible in the screenshot, use questionType "none", set answer to "No question detected — please navigate to a page with a study question and try again.", why to "", deepExplanation to "", confidence to 0.

For "writing" type — when the question asks for a paragraph/essay with formatting requirements:
- Write a full paragraph (8+ sentences) in the answer field using HTML tags
- Use <u>...</u> for the topic sentence
- Use <span class="ss-blue">word</span> for subordinate conjunctions (although, because, since, while, if, unless, when, after, before, as)
- Use <span class="ss-green">word</span> for coordinate conjunctions (for, and, nor, but, or, yet, so)
- Use <span class="ss-red">word</span> for transitional adverbs (however, furthermore, additionally, consequently, therefore, moreover, nevertheless, meanwhile)
- Use <strong>verb phrase</strong> for verb tense variety

For all other types — plain text answers only.
Keep "why" to 2-3 sentences. Keep "deepExplanation" to a short paragraph or leave empty "".`;

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
        ? `INSTRUCTIONS:
1. Use the SCREENSHOT to identify which questions are already answered — look for checkmarks ✓, X marks ✗, colored highlights, or any selected/filled option. Skip ALL answered questions.
2. Use the TEXT below for exact question wording and option text (zero OCR errors).
3. Answer ONLY the first question where all options appear unselected in the screenshot.

--- Extracted page text ---
${pageText}`
        : 'Identify and answer the first unanswered study question visible in the screenshot.',
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
      max_tokens: 1200,
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

  const data = await response.json();
  const raw  = data.choices?.[0]?.message?.content ?? '';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not parse AI response');
  return JSON.parse(match[0]);
}

// ── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { imageDataUrl, token, pageText = null } = req.body;
    if (!imageDataUrl) return res.status(400).json({ error: 'No image provided.' });

    // ── Auth: verify user token ──────────────────────────────────────────────
    let user   = null;
    let isPro  = false;

    if (token) {
      user = getUserFromToken(token);

      if (user) {
        // Check Pro subscription
        const { data: sub } = await supabase
          .from('subscriptions')
          .select('status')
          .eq('user_id', user.id)
          .eq('status', 'active')
          .single();

        isPro = Boolean(sub);
      }
    }

    // ── Usage check: enforce free tier limit ─────────────────────────────────
    if (user && !isPro) {
      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

      // Use the user's own JWT — RLS policy allows users to read/write their own rows
      // Read today's count using service role (bypasses RLS)
      const { data: usage } = await supabase
        .from('usage')
        .select('count')
        .eq('user_id', user.id)
        .eq('date', today)
        .single();

      const todayCount = usage?.count ?? 0;

      if (todayCount >= FREE_LIMIT) {
        return res.status(429).json({
          error: `Free limit reached (${FREE_LIMIT}/day). Upgrade to Pro for unlimited captures.`,
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

    // ── Smart model routing ──────────────────────────────────────────────────
    // Step 1: gpt-4o-mini — fast, cheap, handles 90% of questions perfectly
    const base64Image = imageDataUrl.replace(/^data:image\/\w+;base64,/, '');
    let result = await callOpenAI('gpt-4o-mini', base64Image, pageText);

    // Step 2: if writing assignment detected, upgrade to gpt-4o for quality
    if (result.questionType === 'writing') {
      result = await callOpenAI('gpt-4o', base64Image, pageText);
    }

    return res.status(200).json({ ...result, isPro });

  } catch (err) {
    console.error('[StudySnap API]', err.message);
    return res.status(500).json({ error: err.message || 'Something went wrong — please try again.' });
  }
}
