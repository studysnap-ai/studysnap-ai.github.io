// api/referrals.js
// GET  — returns how many people this user has referred
// POST — claims a referral code (new user was invited by someone)

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function getUserFromToken(token) {
  try {
    const payload = token.split('.')[1];
    const json = Buffer.from(
      payload.replace(/-/g, '+').replace(/_/g, '/'),
      'base64'
    ).toString('utf8');
    const data = JSON.parse(json);
    if (data.exp && data.exp < Math.floor(Date.now() / 1000)) return null;
    if (!data.sub) return null;
    return { id: data.sub, email: data.email };
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });

  const user = getUserFromToken(token);
  if (!user) return res.status(401).json({ error: 'Invalid token.' });

  // ── GET: return referral count + bonus ────────────────────────────────────
  if (req.method === 'GET') {
    const [{ data: count }, { data: bonus }] = await Promise.all([
      supabase.rpc('get_referral_count', { p_user_id: user.id }),
      supabase.rpc('get_referral_bonus', { p_user_id: user.id }),
    ]);
    return res.status(200).json({
      count:      count  ?? 0,
      bonus:      bonus  ?? 0,
      nextMilestone: 3 - ((count ?? 0) % 3),
    });
  }

  // ── POST: claim a referral code ───────────────────────────────────────────
  if (req.method === 'POST') {
    const { referralCode } = req.body;
    if (!referralCode) return res.status(400).json({ error: 'No referral code provided.' });

    const { data: success, error } = await supabase.rpc('claim_referral', {
      p_referred_id:    user.id,
      p_referrer_code:  referralCode.trim().toLowerCase(),
    });

    if (error) {
      console.error('[StudySnap] referral claim error:', error.message);
      return res.status(500).json({ error: 'Could not claim referral.' });
    }

    return res.status(200).json({ success: Boolean(success) });
  }

  return res.status(405).end();
}
