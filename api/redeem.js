// api/redeem.js — Self-service fallback when a user's Ko-fi email differs from
// their StudySnap (Google) account email.
//
//   GET /api/redeem?kofi_transaction_id=xxx&studysnap_email=yyy
//
// Applies the transaction's credits to the StudySnap account matching
// studysnap_email and marks the transaction redeemed (once).

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ success: false, error: 'Method not allowed' });

  const txnId = req.query.kofi_transaction_id;
  const email = req.query.studysnap_email;
  if (!txnId || !email) {
    return res.status(400).json({ success: false, error: 'Missing kofi_transaction_id or studysnap_email' });
  }

  try {
    const { data, error } = await supabase.rpc('redeem_kofi', {
      p_txn_id:          txnId,
      p_studysnap_email: email,
    });
    if (error) return res.status(500).json({ success: false, error: error.message });

    const result = typeof data === 'string' ? JSON.parse(data) : data;
    return res.status(result.success ? 200 : 400).json(result);

  } catch (err) {
    console.error('[Ko-fi redeem]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
