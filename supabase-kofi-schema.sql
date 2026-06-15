-- supabase-kofi-schema.sql — Ko-fi credits system (runs PARALLEL to Stripe)
-- Run this in the Supabase SQL editor. Safe to re-run (idempotent).
--
-- NOTE: credits are a NEW currency. They are awarded + displayed, but not yet
-- consumed by captures (analyze.js still uses the daily limit / Stripe Pro).
-- Wiring consumption is a deliberate follow-up step.

-- ── Tables ───────────────────────────────────────────────────────────────────

-- Per-user credit balance
create table if not exists user_credits (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  credits    integer not null default 0,
  updated_at timestamptz default now()
);

-- Every Ko-fi payment we receive (idempotent on kofi_transaction_id)
create table if not exists kofi_transactions (
  kofi_transaction_id text primary key,
  email               text not null,
  tier_name           text,
  credits_awarded     integer not null,
  amount              numeric,
  currency            text,
  type                text,
  ts                  timestamptz default now(),
  redeemed_at         timestamptz,
  redeemed_by_email   text
);

-- Credits awaiting a matching account (keyed by email)
create table if not exists kofi_pending_credits (
  id                  uuid primary key default gen_random_uuid(),
  email               text not null,
  credits             integer not null,
  tier_name           text,
  kofi_transaction_id text,
  created_at          timestamptz default now()
);
create index if not exists idx_pending_email on kofi_pending_credits (lower(email));

alter table user_credits         enable row level security;
alter table kofi_transactions    enable row level security;
alter table kofi_pending_credits enable row level security;
-- No public policies: all access is via the service role + the RPCs below.

-- ── RPCs (SECURITY DEFINER — run as postgres, bypass RLS) ────────────────────

-- Add credits to a user (upsert); returns the new balance
create or replace function add_user_credits(p_user_id uuid, p_credits integer)
returns integer language plpgsql security definer set search_path = public as $$
declare v_total integer;
begin
  insert into user_credits (user_id, credits, updated_at)
  values (p_user_id, p_credits, now())
  on conflict (user_id) do update
    set credits = user_credits.credits + p_credits, updated_at = now()
  returning credits into v_total;
  return v_total;
end; $$;

-- Current credit balance for a user
create or replace function get_user_credits(p_user_id uuid)
returns integer language sql security definer set search_path = public as $$
  select coalesce((select credits from user_credits where user_id = p_user_id), 0);
$$;

-- Record + award a Ko-fi transaction. Idempotent on kofi_transaction_id.
-- If the email matches an existing user → credit immediately.
-- Otherwise → queue in kofi_pending_credits. Returns 'credited'|'pending'|'duplicate'.
create or replace function award_kofi(
  p_txn_id text, p_email text, p_tier text, p_credits integer,
  p_amount numeric, p_currency text, p_type text
) returns text language plpgsql security definer set search_path = public, auth as $$
declare v_user uuid;
begin
  if exists (select 1 from kofi_transactions where kofi_transaction_id = p_txn_id) then
    return 'duplicate';
  end if;

  insert into kofi_transactions
    (kofi_transaction_id, email, tier_name, credits_awarded, amount, currency, type)
  values (p_txn_id, p_email, p_tier, p_credits, p_amount, p_currency, p_type);

  select id into v_user from auth.users where lower(email) = lower(p_email) limit 1;

  if v_user is not null then
    perform add_user_credits(v_user, p_credits);
    update kofi_transactions
      set redeemed_at = now(), redeemed_by_email = p_email
      where kofi_transaction_id = p_txn_id;
    return 'credited';
  else
    insert into kofi_pending_credits (email, credits, tier_name, kofi_transaction_id)
    values (p_email, p_credits, p_tier, p_txn_id);
    return 'pending';
  end if;
end; $$;

-- Apply any pending credits for a freshly-authenticated user (atomic).
-- Called from /api/usage on every popup open. Returns credits applied this call.
create or replace function apply_pending_credits(p_user_id uuid, p_email text)
returns integer language plpgsql security definer set search_path = public as $$
declare v_sum integer;
begin
  with moved as (
    delete from kofi_pending_credits
    where lower(email) = lower(p_email)
    returning credits
  )
  select coalesce(sum(credits), 0) into v_sum from moved;

  if v_sum > 0 then
    perform add_user_credits(p_user_id, v_sum);
    update kofi_transactions
      set redeemed_at = now(), redeemed_by_email = p_email
      where lower(email) = lower(p_email) and redeemed_at is null;
  end if;
  return v_sum;
end; $$;

-- Self-service fallback: redeem a transaction onto a StudySnap account whose
-- email differs from the Ko-fi email. Returns json { success, credits_added }.
create or replace function redeem_kofi(p_txn_id text, p_studysnap_email text)
returns json language plpgsql security definer set search_path = public, auth as $$
declare v_txn kofi_transactions; v_user uuid;
begin
  select * into v_txn from kofi_transactions where kofi_transaction_id = p_txn_id;
  if v_txn is null then
    return json_build_object('success', false, 'error', 'Transaction not found');
  end if;
  if v_txn.redeemed_at is not null then
    return json_build_object('success', false, 'error', 'Already redeemed');
  end if;

  select id into v_user from auth.users where lower(email) = lower(p_studysnap_email) limit 1;
  if v_user is null then
    return json_build_object('success', false, 'error', 'No StudySnap account for that email');
  end if;

  perform add_user_credits(v_user, v_txn.credits_awarded);
  delete from kofi_pending_credits where kofi_transaction_id = p_txn_id;
  update kofi_transactions
    set redeemed_at = now(), redeemed_by_email = p_studysnap_email
    where kofi_transaction_id = p_txn_id;

  return json_build_object('success', true, 'credits_added', v_txn.credits_awarded);
end; $$;

grant execute on function add_user_credits(uuid, integer)               to service_role;
grant execute on function get_user_credits(uuid)                        to service_role, authenticated;
grant execute on function award_kofi(text, text, text, integer, numeric, text, text) to service_role;
grant execute on function apply_pending_credits(uuid, text)             to service_role;
grant execute on function redeem_kofi(text, text)                       to service_role;
