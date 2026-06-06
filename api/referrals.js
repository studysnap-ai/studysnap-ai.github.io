// api/referrals.js
// GET  — returns how many people this user has referred
// POST — claims a referral code (new user was invited by someone)

import { createClient } from '@supabase/supabase-js';
import { verifyUser, bearerToken } from './_auth.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });

  const user = await verifyUser(token);
  if (!user) return res.status(401).json({ error: 'Invalid token.' });

  // ── GET: return referral count + bonus ────────────────────────────────────
  if (req.method === 'GET') {
    const [{ data: total }, { data: paying }, { data: pendingCoupon }] = await Promise.all([
      supabase.rpc('get_referral_count',         { p_user_id: user.id }),
      supabase.rpc('get_paying_referral_count',  { p_user_id: user.id }),
      supabase.rpc('get_pending_referral_coupon',{ p_user_id: user.id }),
    ]);
    const payingCount = paying ?? 0;
    return res.status(200).json({
      total:         total        ?? 0,
      paying:        payingCount,
      nextMilestone: 3 - (payingCount % 3),
      hasPendingDiscount: Boolean(pendingCoupon),
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
