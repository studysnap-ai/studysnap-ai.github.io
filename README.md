# ⚡ StudySnap — AI Study Assistant

StudySnap is a Chrome extension that helps students understand on-screen study
questions fast. Capture any quiz or study question, get an instant AI answer
with a clear "why" explanation and a confidence score — shown in a floating
overlay right on the page. **No API key needed — just sign in with Google.**

Live site: **https://trystudysnap.com**

---

## How it works

1. The user clicks the StudySnap icon (or presses **Ctrl/Cmd+Shift+K**).
2. The extension screenshots the active tab and reads the visible question text.
3. It sends that to the StudySnap backend, which calls OpenAI and returns an
   answer + explanation + confidence.
4. The answer is shown in an overlay on the page. Screenshots are **never stored**.

Smart model routing keeps it cheap: fast model first, automatic upgrade to a
stronger model only when the answer isn't clear-cut.

---

## Architecture

| Piece | Tech |
|---|---|
| Extension | Chrome MV3 — `manifest.json`, `background.js` (service worker), `popup.*`, `content.js` + `overlay.css` (page overlay), `selector.js` (region capture) |
| Backend | Vercel serverless functions in `api/` |
| Auth | Google OAuth via **Supabase** (PKCE) — JWTs verified server-side (`api/_auth.js`) |
| Database | Supabase (Postgres) — usage counts, subscriptions, Ko-fi credits |
| AI | OpenAI (server-side; users never supply a key) |
| Payments | **Ko-fi** memberships → credits (`api/kofi-webhook.js`). See below. |

### Key endpoints (`api/`)
- `analyze.js` — capture → AI answer (handles free daily limit → credits).
- `usage.js` — returns the user's usage, plan, and credit balance.
- `kofi-webhook.js` — Ko-fi payments → credits (token-verified, idempotent).
- `redeem.js` — authenticated self-service credit redemption.
- `reward.js`, `referrals.js` — share-for-+1 and referral tracking.
- `_auth.js`, `_config.js` — shared JWT verification and limits.

---

## Plans

- **Free** — 5 captures/day.
- **Credits (Ko-fi)** — support on Ko-fi for monthly credits; each credit is one
  extra capture beyond the free daily allowance. Subscription renewals reset the
  monthly balance.

---

## Setup

Backend env vars (see `.env.example`): `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `KOFI_VERIFICATION_TOKEN`.

Database: run `supabase-schema.sql` then `supabase-kofi-schema.sql` and
`supabase-kofi-v2.sql` in the Supabase SQL editor.

Local backend: `vercel dev` (needs the env vars in `.env.local`).
Ko-fi test scripts: `scripts/test-kofi.mjs`, `scripts/diag-kofi.mjs`.

### Load the extension locally
1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this folder.

---

## License

Private project. © StudySnap.
