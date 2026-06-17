// api/usage.js — Returns the current user's usage stats

import { createClient } from '@supabase/supabase-js';
import { verifyUser, bearerToken } from './_auth.js';
import { FREE_LIMIT } from './_config.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // Prevent browser/CDN caching so the count always reflects reality
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });

  const user = await verifyUser(token);
  if (!user) return res.status(401).json({ error: 'Invalid or expired token.' });

  try {
    const today = new Date().toISOString().split('T')[0];

    // Check subscription via SECURITY DEFINER RPC (bypasses RLS)
    const subResult = await supabase.rpc('get_subscription', { p_user_id: user.id });
    if (subResult.error) console.error('[usage] get_subscription error:', subResult.error.message);
    const status = subResult.data;
    const isPro = status === 'active';

    const monthStart = today.slice(0, 7) + '-01';

    // Apply any Ko-fi credits that arrived before this account existed (atomic,
    // no-op if none). Runs on every popup open — our de-facto "on login" hook.
    await supabase.rpc('apply_pending_credits', { p_user_id: user.id, p_email: user.email })
      .catch(() => {});

    const [usageResult, bonusResult, monthlyResult, creditsResult] = await Promise.all([
      supabase.rpc('get_usage',         { p_user_id: user.id, p_date: today }),
      supabase.rpc('get_bonus',         { p_user_id: user.id, p_date: today }),
      supabase.rpc('get_monthly_usage', { p_user_id: user.id, p_month_start: monthStart }),
      supabase.rpc('get_user_credits',  { p_user_id: user.id }),
    ]);
    if (usageResult.error)   console.error('[usage] get_usage error:',         usageResult.error.message);
    if (bonusResult.error)   console.error('[usage] get_bonus error:',         bonusResult.error.message);
    if (monthlyResult.error) console.error('[usage] get_monthly_usage error:', monthlyResult.error.message);
    if (creditsResult.error) console.error('[usage] get_user_credits error:',  creditsResult.error.message);
    const usedToday  = usageResult.data;
    const bonus      = bonusResult.data;
    const monthlyUsed = monthlyResult.data;
    const credits    = creditsResult.data;

    const count          = usedToday  ?? 0;
    const bonusCaptures  = bonus      ?? 0;
    const effectiveLimit = FREE_LIMIT + bonusCaptures;

    return res.status(200).json({
      isPro,
      usedToday:    count,
      usedThisMonth: monthlyUsed ?? 0,
      limit:        isPro ? null : effectiveLimit,
      bonus:        bonusCaptures,
      remaining:    isPro ? null : Math.max(0, effectiveLimit - count),
      credits:      credits ?? 0,
      user: {
        id:     user.id,
        email:  user.email,
        name:   user.name,
        avatar: user.avatar,
      },
    });

  } catch (err) {
    console.error('[StudySnap API] usage error:', err?.message ?? String(err), err?.stack ?? '');
    return res.status(500).json({ error: 'Something went wrong.' });
  }
}
