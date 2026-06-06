-- StudySnap v2.0 — Supabase Database Schema
-- Run this in your Supabase SQL editor

-- Usage tracking (free tier: 5 captures/day — see api/_config.js)
create table if not exists usage (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users(id) on delete cascade not null,
  date       date not null,
  count      integer not null default 0,
  created_at timestamptz default now(),
  unique(user_id, date)
);

-- Pro subscriptions (managed by Stripe webhook)
create table if not exists subscriptions (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid references auth.users(id) on delete cascade not null unique,
  stripe_customer_id      text,
  stripe_subscription_id  text,
  status                  text not null default 'inactive', -- active | cancelled | inactive
  period_end              timestamptz,
  created_at              timestamptz default now(),
  updated_at              timestamptz default now()
);

-- Row Level Security: users can only see their own data
alter table usage         enable row level security;
alter table subscriptions enable row level security;

create policy "Users see own usage"
  on usage for all using (auth.uid() = user_id);

create policy "Users see own subscription"
  on subscriptions for select using (auth.uid() = user_id);

-- Service role bypasses RLS (used by our API functions)

-- ── RPC functions (SECURITY DEFINER — run as postgres, bypass all RLS) ────────
-- These are required by the API. Run them in the Supabase SQL editor.

-- Returns today's capture count for a user (used by /api/usage)
create or replace function get_usage(p_user_id uuid, p_date date)
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

-- Increments (or inserts) today's capture count for a user (used by /api/analyze)
create or replace function increment_usage(p_user_id uuid, p_date date)
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

-- Returns subscription status for a user (used by /api/usage and /api/analyze)
create or replace function get_subscription(p_user_id uuid)
returns text
language sql
security definer
set search_path = public
as $$
  select status from subscriptions where user_id = p_user_id limit 1;
$$;

-- Grant execute to the service role and anon role
grant execute on function get_usage(uuid, date)        to service_role, anon, authenticated;
grant execute on function increment_usage(uuid, date)  to service_role, anon, authenticated;
grant execute on function get_subscription(uuid)       to service_role, anon, authenticated;

-- ── Share for +1 reward ────────────────────────────────────────────────────
-- Adds a bonus column to usage to track extra captures earned via sharing.
-- Run this block once in Supabase SQL Editor.

alter table usage add column if not exists bonus integer not null default 0;

-- Returns bonus captures earned today
create or replace function get_bonus(p_user_id uuid, p_date date)
returns integer
language sql
security definer
set search_path = public
as $$
  select coalesce((select bonus from usage where user_id = p_user_id and date = p_date), 0);
$$;

-- Awards +1 share bonus (max 1 per day — idempotent)
create or replace function add_share_reward(p_user_id uuid, p_date date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_bonus integer;
begin
  insert into usage (user_id, date, count, bonus)
  values (p_user_id, p_date, 0, 1)
  on conflict (user_id, date) do update
    set bonus = least(usage.bonus + 1, 1)   -- cap at 1 share reward per day
  returning bonus into v_bonus;
  return v_bonus;
end;
$$;

grant execute on function get_bonus(uuid, date)          to service_role, anon, authenticated;
grant execute on function add_share_reward(uuid, date)   to service_role, anon, authenticated;

-- ── Referral system ────────────────────────────────────────────────────────
-- Each row = one person who signed up using someone else's referral code.
-- Referrer earns +1 permanent daily capture for every 3 referrals.

create table if not exists referrals (
  id          uuid primary key default gen_random_uuid(),
  referrer_id uuid references auth.users(id) on delete cascade not null,
  referred_id uuid references auth.users(id) on delete cascade not null unique,
  created_at  timestamptz default now()
);

alter table referrals enable row level security;

create policy "Users see own referrals"
  on referrals for select using (auth.uid() = referrer_id);

-- Returns how many people this user has referred
create or replace function get_referral_count(p_user_id uuid)
returns integer
language sql security definer set search_path = public
as $$
  select count(*)::integer from referrals where referrer_id = p_user_id;
$$;

-- Returns permanent bonus captures earned via referrals (floor(count / 3))
create or replace function get_referral_bonus(p_user_id uuid)
returns integer
language sql security definer set search_path = public
as $$
  select floor(count(*)::float / 3)::integer from referrals where referrer_id = p_user_id;
$$;

-- Claims a referral: records that p_referred_id joined via p_referrer_code
-- p_referrer_code is the first 8 chars of the referrer's user ID
create or replace function claim_referral(p_referred_id uuid, p_referrer_code text)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare v_referrer_id uuid;
begin
  -- Find the referrer by their short code
  select id into v_referrer_id from auth.users
  where left(id::text, 8) = p_referrer_code limit 1;

  if v_referrer_id is null then return false; end if;
  if v_referrer_id = p_referred_id then return false; end if; -- can't refer yourself

  insert into referrals (referrer_id, referred_id)
  values (v_referrer_id, p_referred_id)
  on conflict (referred_id) do nothing;  -- each new user can only be referred once

  return true;
end;
$$;

grant execute on function get_referral_count(uuid)   to service_role, anon, authenticated;
grant execute on function get_referral_bonus(uuid)   to service_role, anon, authenticated;
grant execute on function claim_referral(uuid, text) to service_role, anon, authenticated;

-- ── Pro monthly cap (700 captures) ────────────────────────────────────────
-- Sums all daily usage rows since the start of the current month.

create or replace function get_monthly_usage(p_user_id uuid, p_month_start date)
returns integer
language sql security definer set search_path = public
as $$
  select coalesce(sum(count), 0)::integer
  from usage
  where user_id = p_user_id and date >= p_month_start;
$$;

grant execute on function get_monthly_usage(uuid, date) to service_role, anon, authenticated;

-- ── Referral discount credits ──────────────────────────────────────────────
-- Earned when 3 of your referrals convert to paying Pro users.
-- Each credit stores a unique Stripe coupon ID for $1 off first month.

alter table referrals add column if not exists converted_to_pro boolean default false;
alter table referrals add column if not exists converted_at      timestamptz;

create table if not exists referral_credits (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid references auth.users(id) on delete cascade not null,
  stripe_coupon_id text not null,
  used             boolean default false,
  created_at       timestamptz default now()
);

-- Returns an unused Stripe coupon ID for this user (null if none)
create or replace function get_pending_referral_coupon(p_user_id uuid)
returns text
language sql security definer set search_path = public
as $$
  select stripe_coupon_id from referral_credits
  where user_id = p_user_id and used = false
  order by created_at asc limit 1;
$$;

-- Marks a coupon as used after checkout completes
create or replace function use_referral_credit(p_user_id uuid, p_coupon_id text)
returns void
language sql security definer set search_path = public
as $$
  update referral_credits set used = true
  where user_id = p_user_id and stripe_coupon_id = p_coupon_id;
$$;

-- Returns count of paying referrals for a user
create or replace function get_paying_referral_count(p_user_id uuid)
returns integer
language sql security definer set search_path = public
as $$
  select count(*)::integer from referrals
  where referrer_id = p_user_id and converted_to_pro = true;
$$;

grant execute on function get_pending_referral_coupon(uuid)      to service_role, anon, authenticated;
grant execute on function use_referral_credit(uuid, text)        to service_role, anon, authenticated;
grant execute on function get_paying_referral_count(uuid)        to service_role, anon, authenticated;
grant execute on function get_monthly_usage(uuid, date)          to service_role, anon, authenticated;
