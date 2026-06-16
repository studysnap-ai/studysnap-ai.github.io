// scripts/diag-kofi.mjs — runs the Ko-fi webhook handler directly (no vercel dev)
// to surface the REAL error and prove the code + Supabase pipeline work.
// Run from the project root:  node scripts/diag-kofi.mjs

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// --- Load .env.local into process.env manually ---
try {
  const txt = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  console.log('Loaded .env.local');
} catch (e) {
  console.log('⚠️  Could not read .env.local:', e.message);
}

console.log('  SUPABASE_URL set? ', !!process.env.SUPABASE_URL);
console.log('  SERVICE_ROLE set? ', !!process.env.SUPABASE_SERVICE_ROLE_KEY);
console.log('  KOFI token set?   ', !!process.env.KOFI_VERIFICATION_TOKEN);
if (!process.env.KOFI_VERIFICATION_TOKEN) process.env.KOFI_VERIFICATION_TOKEN = 'local-test-token';

// --- Import the handler (this is where a module-load crash would throw) ---
let handler;
try {
  const mod = await import('../api/kofi-webhook.js');
  handler = mod.default;
  console.log('✓ webhook module loaded OK');
} catch (err) {
  console.error('\n✗ MODULE LOAD FAILED — this is your 500:\n', err);
  process.exit(1);
}

// --- Fake one Ko-fi donation event and call the handler directly ---
const payload = {
  verification_token: process.env.KOFI_VERIFICATION_TOKEN,
  type: 'Donation', from_name: 'Diag', message: '', amount: '12.00',
  email: 'donor@gmail.com', currency: 'USD',
  is_subscription_payment: false, tier_name: null,
  kofi_transaction_id: 'diag-' + randomUUID(), is_public: true,
};
const req = { method: 'POST', body: { data: JSON.stringify(payload) } };
const res = {
  statusCode: 200,
  status(c) { this.statusCode = c; return this; },
  json(o) { console.log('\nHANDLER RESPONSE →', this.statusCode, JSON.stringify(o)); return this; },
  end() { console.log('\nHANDLER RESPONSE →', this.statusCode, '(end)'); return this; },
  setHeader() {},
};

try {
  await handler(req, res);
  console.log('\n✓ Done. Check kofi_transactions / kofi_pending_credits in Supabase.');
} catch (err) {
  console.error('\n✗ HANDLER THREW:\n', err);
}
