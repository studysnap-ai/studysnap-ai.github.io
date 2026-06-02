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

const SYSTEM_PROMPT = `You are StudySnap, an AI study assistant. Analyze the screenshot and answer the study question shown.

IMPORTANT: You MUST always respond with valid JSON only — no markdown, no code fences, no explanation outside the JSON. Even if no question is visible, return a JSON object with questionType "none".

If multiple questions are visible, focus on the FIRST UNANSWERED question. A question is already answered if it has a checkmark, a filled radio button, a highlighted/selected option, or any other visual indicator of a chosen answer — skip those and move to the next unanswered one.

Respond ONLY with valid JSON in this exact format:
{
  "questionType": "mcq" | "truefalse" | "fillin" | "short" | "writing" | "none",
  "answer": "...",
  "why": "...",
  "deepExplanation": "...",
  "confidence": 0-100
}

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

async function callOpenAI(model, base64Image) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 1200,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${base64Image}`, detail: 'high' },
            },
            { type: 'text', text: 'What is the question and answer?' },
          ],
        },
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
    const { imageDataUrl, token } = req.body;
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

      // Increment usage
      await supabase.from('usage').upsert(
        { user_id: user.id, date: today, count: todayCount + 1 },
        { onConflict: 'user_id,date' }
      );
    }

    // ── Smart model routing ──────────────────────────────────────────────────
    // Step 1: gpt-4o-mini — fast, cheap, handles 90% of questions perfectly
    const base64Image = imageDataUrl.replace(/^data:image\/\w+;base64,/, '');
    let result = await callOpenAI('gpt-4o-mini', base64Image);

    // Step 2: if writing assignment detected, upgrade to gpt-4o for quality
    if (result.questionType === 'writing') {
      result = await callOpenAI('gpt-4o', base64Image);
    }

    return res.status(200).json({ ...result, isPro });

  } catch (err) {
    console.error('[StudySnap API]', err.message);
    return res.status(500).json({ error: err.message || 'Something went wrong — please try again.' });
  }
}
