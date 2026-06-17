-- supabase-patch-v3.sql — Bug fixes for the Ko-fi credits system.
-- Run AFTER supabase-schema.sql AND supabase-kofi-v2.sql. Safe to re-run.
--
-- Fixes:
--   1. Missing index on kofi_transactions(email) — O(n) scans on every webhook + redemption
--   2. apply_pending_credits: subscription payments must SET (reset) credits, not ADD
--      (without this, a subscription user whose email didn't match gets double-credited
--       when they later log in and pending credits are applied)
--   3. redeem_kofi_user: redeemed_by_email was never set — audit trail was blind

-- ── 1. Index: kofi_transactions.email ────────────────────────────────────────
-- award_kofi does:   UPDATE kofi_transactions WHERE lower(email) = lower(p_email)
-- apply_pending does: UPDATE kofi_transactions WHERE lower(email) = lower(p_email)
-- Both run on every Ko-fi webhook / popup open. Without an index this is a seq scan.

create index if not exists idx_kofi_txn_email on kofi_transactions (lower(email));

-- ── 2. apply_pending_credits: subscription vs tip awareness ──────────────────
-- Before this patch, ALL pending credits were applied with add_user_credits (ADD).
-- Subscription payments must use set_user_credits (SET/reset) — same rule as the
-- live path in award_kofi (v2). This function now looks up the original transaction
-- type for each pending row and routes to set_ or add_ accordingly.
-- Requires set_user_credits (defined in supabase-kofi-v2.sql).

create or replace function apply_pending_credits(p_user_id uuid, p_email text)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_sum  integer := 0;
  v_rec  record;
  v_type text;
begin
  -- Delete each pending row individually so we can inspect the transaction type
  for v_rec in
    delete from kofi_pending_credits
    where lower(email) = lower(p_email)
    returning credits, kofi_transaction_id
  loop
    select type into v_type
    from kofi_transactions
    where kofi_transaction_id = v_rec.kofi_transaction_id;

    -- Subscriptions RESET the monthly balance; one-time tips ADD on top
    if v_type = 'Subscription' then
      perform set_user_credits(p_user_id, v_rec.credits);
    else
      perform add_user_credits(p_user_id, v_rec.credits);
    end if;

    v_sum := v_sum + v_rec.credits;
  end loop;

  if v_sum > 0 then
    update kofi_transactions
      set redeemed_at = now(), redeemed_by_email = p_email
      where lower(email) = lower(p_email) and redeemed_at is null;
  end if;

  return v_sum;
end; $$;

grant execute on function apply_pending_credits(uuid, text) to service_role;

-- ── 3. redeem_kofi_user: record redeemed_by_email ────────────────────────────
-- The v2 version forgot to set redeemed_by_email, leaving the audit field blank
-- for every self-service redemption (where Ko-fi email ≠ StudySnap email).
-- Also: subscription type now correctly SETs credits instead of ADDing.

create or replace function redeem_kofi_user(p_txn_id text, p_user_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_txn   kofi_transactions;
  v_email text;
begin
  select * into v_txn from kofi_transactions where kofi_transaction_id = p_txn_id;
  if v_txn is null then
    return json_build_object('success', false, 'error', 'Transaction not found');
  end if;
  if v_txn.redeemed_at is not null then
    return json_build_object('success', false, 'error', 'Already redeemed');
  end if;

  -- Resolve the authenticated user's email for the audit trail
  select email into v_email from auth.users where id = p_user_id;

  -- Subscription → reset balance; tip → top up
  if v_txn.type = 'Subscription' then
    perform set_user_credits(p_user_id, v_txn.credits_awarded);
  else
    perform add_user_credits(p_user_id, v_txn.credits_awarded);
  end if;

  delete from kofi_pending_credits where kofi_transaction_id = p_txn_id;
  update kofi_transactions
    set redeemed_at = now(), redeemed_by_email = v_email
    where kofi_transaction_id = p_txn_id;

  return json_build_object('success', true, 'credits_added', v_txn.credits_awarded);
end; $$;

grant execute on function redeem_kofi_user(text, uuid) to service_role;
