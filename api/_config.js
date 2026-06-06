// api/_config.js — Shared limits for the backend functions.
// Defined once so analyze.js, usage.js and reward.js can never drift apart.

export const FREE_LIMIT        = 5;   // captures per day on the free tier
export const PRO_MONTHLY_LIMIT = 700; // captures per month on Pro
