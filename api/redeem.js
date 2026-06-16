// api/redeem.js — Self-service fallback when a user's Ko-fi email differs from
// their StudySnap (Google) email.
//
//   POST /api/redeem   { kofi_transaction_id }
//   Authorization: Bearer <supabase access token>
//
// SECURITY: the target account is derived from the caller's VERIFIED token, not
// from a request parameter — so a transaction can only ever be redeemed onto the
// account of the person making the (authenticated) request. This prevents anyone
// who happens to know a transaction ID from claiming it to an arbitrary email.

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
  if (req.method !== 'POST')    return res.status(405).json({ success: false, error: 'Method not allowed' });

  const token = bearerToken(req);
  if (!token) return res.status(401).json({ success: false, error: 'Not authenticated. Redeem from the StudySnap extension while signed in.' });

  const user = await verifyUser(token);
  if (!user) return res.status(401).json({ success: false, error: 'Invalid or expired session.' });

  const txnId = req.body?.kofi_transaction_id;
  if (!txnId) return res.status(400).json({ success: false, error: 'Missing kofi_transaction_id.' });

  try {
    const { data, error } = await supabase.rpc('redeem_kofi_user', {
      p_txn_id:  String(txnId).trim(),
      p_user_id: user.id,
    });
    if (error) return res.status(500).json({ success: false, error: error.message });

    const result = typeof data === 'string' ? JSON.parse(data) : data;
    return res.status(result.success ? 200 : 400).json(result);

  } catch (err) {
    console.error('[Ko-fi redeem]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
