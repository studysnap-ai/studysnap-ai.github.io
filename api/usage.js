// api/usage.js — Returns the current user's usage stats

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const FREE_LIMIT = 10;

// Decode a Supabase-issued JWT without a network call.
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
      id:       data.sub,
      email:    data.email,
      name:     data.user_metadata?.full_name  || data.email,
      avatar:   data.user_metadata?.avatar_url || null,
    };
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });

  const user = getUserFromToken(token);
  if (!user) return res.status(401).json({ error: 'Invalid or expired token.' });

  try {
    const today = new Date().toISOString().split('T')[0];

    // Check subscription
    const { data: sub } = await supabase
      .from('subscriptions')
      .select('status, period_end')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .single();

    const isPro = Boolean(sub);

    // Get today's usage
    const { data: usage } = await supabase
      .from('usage')
      .select('count')
      .eq('user_id', user.id)
      .eq('date', today)
      .single();

    const usedToday = usage?.count ?? 0;

    return res.status(200).json({
      isPro,
      usedToday,
      limit:     FREE_LIMIT,
      remaining: isPro ? 'unlimited' : Math.max(0, FREE_LIMIT - usedToday),
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
