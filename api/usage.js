// api/usage.js — Returns the current user's usage stats

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const FREE_LIMIT = 10;

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
    return {
      id:     data.sub,
      email:  data.email,
      name:   data.user_metadata?.full_name  || data.email,
      avatar: data.user_metadata?.avatar_url || null,
    };
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // Prevent browser/CDN caching so the count always reflects reality
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });

  const user = getUserFromToken(token);
  if (!user) return res.status(401).json({ error: 'Invalid or expired token.' });

  try {
    const today = new Date().toISOString().split('T')[0];

    // Check subscription via SECURITY DEFINER RPC (bypasses RLS)
    const { data: status } = await supabase.rpc('get_subscription', {
      p_user_id: user.id,
    });
    const isPro = status === 'active';

    // Read today's usage via SECURITY DEFINER function (bypasses permission issues)
    const { data: usedToday } = await supabase.rpc('get_usage', {
      p_user_id: user.id,
      p_date:    today,
    });

    const count = usedToday ?? 0;

    return res.status(200).json({
      isPro,
      usedToday:  count,
      limit:      FREE_LIMIT,
      remaining:  isPro ? 'unlimited' : Math.max(0, FREE_LIMIT - count),
      user: {
        id:     user.id,
        email:  user.email,
        name:   user.name,
        avatar: user.avatar,
      },
    });

  } catch (err) {
    console.error('[StudySnap API] usage error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
}
