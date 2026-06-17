// api/feedback.js — Records a 👍/👎 thumb vote for an answer
// Called by background.js after the user taps a feedback button in the overlay.
// Stored in the `feedback` table for quality analytics (which question types
// the AI gets wrong, accuracy by language, confidence calibration, etc.)

import { createClient } from '@supabase/supabase-js';
import { verifyUser, bearerToken } from './_auth.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Auth: feedback must be attributed to a verified user
    const token = bearerToken(req);
    const user  = await verifyUser(token);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { entryId, feedback, questionType, confidence, answer } = req.body;

    if (!feedback || !['correct', 'incorrect'].includes(feedback)) {
      return res.status(400).json({ error: 'feedback must be "correct" or "incorrect"' });
    }
    if (entryId == null) {
      return res.status(400).json({ error: 'entryId is required' });
    }

    const { error } = await supabase.from('feedback').insert({
      user_id:        user.id,
      entry_id:       Number(entryId),
      feedback,
      question_type:  questionType  ?? null,
      confidence:     confidence    ?? null,
      // Truncate answer so we don't store essay-length content
      answer_snippet: answer ? String(answer).slice(0, 300) : null,
    });

    if (error) throw error;

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('[StudySnap feedback]', err.message);
    return res.status(500).json({ error: 'Failed to save feedback' });
  }
}
