// api/reward.js — Awards +1 bonus capture when a user shares StudySnap
// Max 1 share reward per user per day (enforced in the DB via add_share_reward RPC).

import { createClient } from '@supabase/supabase-js';
import { verifyUser, bearerToken } from './_auth.js';
import { FREE_LIMIT } from './_config.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).end();

  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });

  const user = await verifyUser(token);
  if (!user) return res.status(401).json({ error: 'Invalid or expired token.' });

  const today = new Date().toISOString().split('T')[0];

  try {
    const { data: newBonus, error } = await supabase.rpc('add_share_reward', {
      p_user_id: user.id,
      p_date:    today,
    });

    if (error) {
      console.error('[StudySnap] reward error:', error.message);
      return res.status(500).json({ error: 'Could not add reward.' });
    }

    return res.status(200).json({
      success:  true,
      bonus:    newBonus,
      newLimit: FREE_LIMIT + newBonus,
    });

  } catch (err) {
    console.error('[StudySnap] reward error:', err.message);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
}
