// scripts/test-kofi.mjs — simulate Ko-fi webhooks against a local server.
//
// Prereqs:
//   1. Run the SQL in supabase-kofi-schema.sql in your Supabase project.
//   2. Start the backend locally:  vercel dev   (defaults to http://localhost:3000)
//   3. Set KOFI_VERIFICATION_TOKEN in .env (same value used by the server).
//
// Run:
//   KOFI_VERIFICATION_TOKEN=your-token node scripts/test-kofi.mjs
//   (optional) KOFI_WEBHOOK_URL=http://localhost:3000/api/kofi-webhook
//
// Requires Node 18+ (global fetch + crypto.randomUUID).

import { randomUUID } from 'node:crypto';

const URL   = process.env.KOFI_WEBHOOK_URL || 'http://localhost:3000/api/kofi-webhook';
const TOKEN = process.env.KOFI_VERIFICATION_TOKEN || '398e2f79-504c-49e7-bd5f-5e3755e2fd7c';

// To test the "immediate credit" path, set one of these emails to a real user
// in your Supabase auth.users; others will land in kofi_pending_credits.
const events = [
  { type: 'Subscription', tier_name: 'Starter ⚡ 300 Credits',  amount: '5.00',  email: 'jane@gmail.com' },
  { type: 'Subscription', tier_name: 'Pro 📚 700 Credits',      amount: '10.00', email: 'jane@gmail.com' },
  { type: 'Subscription', tier_name: 'Elite 🌟 1200 Credits',   amount: '15.00', email: 'elite@gmail.com' },
  { type: 'Donation',     tier_name: null,                      amount: '12.00', email: 'donor@gmail.com' },
  // Bad token → expect HTTP 403
  { type: 'Donation',     tier_name: null,                      amount: '5.00',  email: 'x@gmail.com', badToken: true },
];

function buildBody(e) {
  const data = JSON.stringify({
    verification_token: e.badToken ? 'WRONG-TOKEN' : TOKEN,
    message_id: randomUUID(),
    timestamp: new Date().toISOString(),
    type: e.type,
    from_name: 'Test User',
    message: '',
    amount: e.amount,
    url: 'https://ko-fi.com/test',
    email: e.email,
    currency: 'USD',
    is_subscription_payment: e.type === 'Subscription',
    is_first_subscription_payment: e.type === 'Subscription',
    tier_name: e.tier_name,
    kofi_transaction_id: randomUUID(),
    shop_items: null,
    is_public: true,
  });
  return new URLSearchParams({ data }).toString();
}

console.log(`POSTing ${events.length} simulated Ko-fi events to ${URL}\n`);

for (const e of events) {
  const label = `${e.type} · ${e.tier_name || `$${e.amount}`}${e.badToken ? ' (bad token)' : ''} · ${e.email}`;
  try {
    const res  = await fetch(URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    buildBody(e),
    });
    const text = await res.text();
    console.log(`${res.status === 200 ? '✓' : '✗'} [${res.status}] ${label}\n    ${text}`);
  } catch (err) {
    console.log(`✗ [ERR] ${label}\n    ${err.message}`);
  }
}

console.log('\nExpected: 4× HTTP 200 (credited/pending), 1× HTTP 403 (bad token).');
console.log('Check the user_credits / kofi_pending_credits / kofi_transactions tables in Supabase.');
