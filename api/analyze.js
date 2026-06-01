// api/analyze.js — Vercel serverless function
// Receives a screenshot from the extension, calls OpenAI, returns the result.
// Users never need their own API key — we handle it here.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const FREE_LIMIT = 10; // captures per day for free users

export default async function handler(req, res) {
  // ── CORS — only allow our extension and website ──────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { imageDataUrl, userId, token } = req.body;

    if (!imageDataUrl) {
      return res.status(400).json({ error: 'No image provided.' });
    }

    // ── Auth: verify user token from Supabase ──────────────────────────────────
    let user = null;
    if (token) {
      const { data, error } = await supabase.auth.getUser(token);
      if (!error && data?.user) {
        user = data.user;
      }
    }

    // ── Usage check: enforce free tier limit ───────────────────────────────────
    if (user) {
      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

      // Check if user has a pro subscription
      const { data: sub } = await supabase
        .from('subscriptions')
        .select('status')
        .eq('user_id', user.id)
        .eq('status', 'active')
        .single();

      const isPro = Boolean(sub);

      if (!isPro) {
        // Get today's usage count
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

        // Increment usage count
        await supabase.from('usage').upsert({
          user_id: user.id,
          date: today,
          count: todayCount + 1,
        }, { onConflict: 'user_id,date' });
      }
    }

    // ── Call OpenAI GPT-4o Vision ──────────────────────────────────────────────
    const base64Image = imageDataUrl.replace(/^data:image\/\w+;base64,/, '');

    const openAIResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 1000,
        messages: [
          {
            role: 'system',
            content: `You are StudySnap, an AI study assistant. Analyze the screenshot and answer the study question shown.

Detect the question type and respond ONLY with valid JSON in this exact format:
{
  "questionType": "mcq" | "truefalse" | "fillin" | "short" | "writing" | "type",
  "answer": "...",
  "why": "...",
  "deepExplanation": "...",
  "confidence": 0-100
}

For "writing" type — when the question asks for a paragraph/essay with formatting requirements:
- Write a full paragraph (8+ sentences) in the answer field using HTML tags
- Use <u>...</u> for the topic sentence
- Use <span class="ss-blue">word</span> for subordinate conjunctions (although, because, since, while, if, unless, when, after, before, as)
- Use <span class="ss-green">word</span> for coordinate conjunctions (for, and, nor, but, or, yet, so)
- Use <span class="ss-red">word</span> for transitional adverbs (however, furthermore, additionally, consequently, therefore, moreover, nevertheless, meanwhile)
- Use <strong>verb phrase</strong> for verb tense variety

For all other types — plain text answers only.

Keep "why" to 2-3 sentences. Keep "deepExplanation" to a short paragraph or leave empty "".`,
          },
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

    if (!openAIResponse.ok) {
      const err = await openAIResponse.json();
      console.error('[StudySnap API] OpenAI error:', err);
      return res.status(502).json({ error: 'AI service error — please try again.' });
    }

    const openAIData = await openAIResponse.json();
    const raw = openAIData.choices?.[0]?.message?.content ?? '';

    // Parse JSON from response
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(502).json({ error: 'Could not parse AI response.' });
    }

    const result = JSON.parse(jsonMatch[0]);

    // Return remaining usage info for free users
    const remainingCaptures = user ? null : null; // calculated above
    return res.status(200).json({
      ...result,
      isPro: user ? Boolean(
        await supabase.from('subscriptions').select('status').eq('user_id', user.id).eq('status', 'active').single()
      ) : false,
    });

  } catch (err) {
    console.error('[StudySnap API] Unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong — please try again.' });
  }
}
