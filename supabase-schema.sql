-- StudySnap v2.0 — Supabase Database Schema
-- Run this in your Supabase SQL editor

-- Usage tracking (free tier: 10 captures/day)
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

-- Grant execute to the service role and anon role
grant execute on function get_usage(uuid, date)       to service_role, anon, authenticated;
grant execute on function increment_usage(uuid, date) to service_role, anon, authenticated;
