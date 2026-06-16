// api/kofi-webhook.js — Ko-fi → StudySnap credits (parallel to Stripe)
//
// Ko-fi POSTs application/x-www-form-urlencoded with a single `data` field
// containing a JSON string. We verify the token, map the payment to a credit
// amount, and award it (immediately if the email matches a user, otherwise
// queued as pending). Always returns 200 so Ko-fi doesn't retry — except a
// wrong verification_token, which gets 403.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Authoritative: map the exact Ko-fi tier name → credits.
const TIER_CREDITS = {
  'Starter ⚡ 300 Credits': 300,
  'Pro 📚 500 Credits':     500,
  'Elite 🌟 1200 Credits':  1200,
};

// Fallback for one-time Donations (no tier_name): map by amount.
function creditsFromAmount(amount) {
  const a = parseFloat(amount) || 0;
  if (a < 10) return 300;
  if (a < 15) return 500;
  return 1200;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Ko-fi delivers `data` as a urlencoded field. Handle both parsed-object
    // and raw-string body shapes.
    let raw = req.body?.data;
    if (!raw && typeof req.body === 'string') {
      raw = new URLSearchParams(req.body).get('data');
    }
    if (!raw) return res.status(200).json({ ok: true, ignored: 'no data field' });

    const payload = JSON.parse(raw);

    // Verify it's really from Ko-fi
    if (payload.verification_token !== process.env.KOFI_VERIFICATION_TOKEN) {
      return res.status(403).json({ error: 'Invalid verification token' });
    }

    // Only process payments — ignore Shop Order / Commission
    if (payload.type !== 'Donation' && payload.type !== 'Subscription') {
      return res.status(200).json({ ok: true, ignored: payload.type });
    }

    const credits = TIER_CREDITS[payload.tier_name] ?? creditsFromAmount(payload.amount);

    const { data: status, error } = await supabase.rpc('award_kofi', {
      p_txn_id:   payload.kofi_transaction_id,
      p_email:    payload.email,
      p_tier:     payload.tier_name ?? null,
      p_credits:  credits,
      p_amount:   parseFloat(payload.amount) || 0,
      p_currency: payload.currency ?? 'USD',
      p_type:     payload.type,
    });

    if (error) console.error('[Ko-fi] award_kofi error:', error.message);

    // Always 200 so Ko-fi marks it delivered
    return res.status(200).json({ ok: true, status: status ?? 'error', credits });

  } catch (err) {
    console.error('[Ko-fi webhook]', err.message);
    // Still 200 on a malformed payload to avoid endless Ko-fi retries
    return res.status(200).json({ ok: false, error: err.message });
  }
}
