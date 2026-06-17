-- supabase-security-patch.sql — Security hardening
-- Run in Supabase SQL Editor. Idempotent.
--
-- Fixes two advisor warnings:
--   1. Revoke anon/authenticated execute on backend-only RPCs
--      (prevents unauthenticated REST calls to credit-manipulation functions)
--   2. Re-create get_usage + increment_usage with explicit set search_path
--      (prevents search_path injection — they exist in live DB without it)

-- ── 1. Revoke anon from ALL RPCs (they're all called from Vercel, not browser) ─
-- Then selectively re-grant anon only for functions used directly by the client
-- (currently: none — the extension calls our Vercel API, which calls Supabase).

-- Backend-only (Vercel service role only) — revoke all public access
revoke execute on function add_user_credits(uuid, integer)            from anon, authenticated;
revoke execute on function set_user_credits(uuid, integer)            from anon, authenticated;
revoke execute on function spend_user_credit(uuid)                    from anon, authenticated;
revoke execute on function award_kofi(text, text, text, integer, numeric, text, text, boolean) from anon, authenticated;
revoke execute on function redeem_kofi(text, text)                    from anon, authenticated;
revoke execute on function redeem_kofi_user(text, uuid)               from anon, authenticated;
revoke execute on function apply_pending_credits(uuid, text)          from anon, authenticated;
revoke execute on function rls_auto_enable()                          from anon, authenticated;

-- Read RPCs called from Vercel (service role does the call) — revoke anon only
-- Keep `authenticated` in case we ever call them from the client directly
revoke execute on function get_usage(uuid, date)                      from anon;
revoke execute on function get_bonus(uuid, date)                      from anon;
revoke execute on function get_subscription(uuid)                     from anon;
revoke execute on function get_user_credits(uuid)                     from anon;
revoke execute on function get_monthly_usage(uuid, date)              from anon;
revoke execute on function get_referral_count(uuid)                   from anon;
revoke execute on function get_referral_bonus(uuid)                   from anon;
revoke execute on function get_paying_referral_count(uuid)            from anon;
revoke execute on function get_pending_referral_coupon(uuid)          from anon;
revoke execute on function add_share_reward(uuid, date)               from anon;
revoke execute on function claim_referral(uuid, text)                 from anon;
revoke execute on function increment_usage(uuid, date)                from anon;
revoke execute on function use_referral_credit(uuid, text)            from anon;

-- ── 2. Re-create the two functions flagged with mutable search_path ───────────
-- The live DB has these as `language plpgsql`; we're switching to `language sql`.
-- Postgres blocks `create or replace` when the language changes, so DROP first.
-- Both functions are short — no data is lost, just the function definition.

drop function if exists get_usage(uuid, date);
drop function if exists increment_usage(uuid, date);

create function get_usage(p_user_id uuid, p_date date)
returns integer
language sql
security definer
set search_path = public
as $$
  select coalesce(
    (select count from usage where user_id = p_user_id and date = p_date),
    0
  );
$$;

create function increment_usage(p_user_id uuid, p_date date)
returns void
language sql
security definer
set search_path = public
as $$
  insert into usage (user_id, date, count)
  values (p_user_id, p_date, 1)
  on conflict (user_id, date)
  do update set count = usage.count + 1;
$$;

-- Re-grant after recreate
grant execute on function get_usage(uuid, date)        to service_role, authenticated;
grant execute on function increment_usage(uuid, date)  to service_role;
