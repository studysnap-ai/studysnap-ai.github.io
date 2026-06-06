// api/_auth.js — Shared authentication helper for all serverless functions.
//
// SECURITY: A Supabase JWT must be cryptographically verified before we trust
// any claim inside it. Decoding the payload locally (without checking the
// signature) lets anyone forge a token with any `sub`/`email`, bypassing auth
// and our usage limits. `supabase.auth.getUser(token)` validates the token's
// signature against the Supabase auth server, so we use it everywhere.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Verifies a Supabase access token and returns the authenticated user.
 * Returns null if the token is missing, malformed, expired, or has an
 * invalid signature.
 *
 * @param {string|null|undefined} token  Raw JWT (no "Bearer " prefix)
 * @returns {Promise<{id: string, email: string, name: string, avatar: string|null}|null>}
 */
export async function verifyUser(token) {
  if (!token) return null;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return null;
    const u = data.user;
    return {
      id:     u.id,
      email:  u.email,
      name:   u.user_metadata?.full_name  || u.email,
      avatar: u.user_metadata?.avatar_url || null,
    };
  } catch {
    return null;
  }
}

/** Extracts the bearer token from an Authorization header. */
export function bearerToken(req) {
  return req.headers.authorization?.replace('Bearer ', '') || null;
}
