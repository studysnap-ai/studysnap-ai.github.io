// api/usage.js — Returns the current user's usage stats
// Called by the extension popup to show remaining captures

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const FREE_LIMIT = 10;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });

  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: 'Invalid token.' });

    const user = data.user;
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
      limit: FREE_LIMIT,
      remaining: isPro ? 'unlimited' : Math.max(0, FREE_LIMIT - usedToday),
      user: {
        id: user.id,
        email: user.email,
        name: user.user_metadata?.full_name,
        avatar: user.user_metadata?.avatar_url,
      },
    });

  } catch (err) {
    console.error('[StudySnap API] usage error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
}
