-- supabase-kofi-v2.sql — Ko-fi credits v2: monthly reset + secured redeem.
-- Run this in the Supabase SQL editor (after supabase-kofi-schema.sql). Idempotent.

-- ── Monthly reset: SET (replace) a balance instead of adding ─────────────────
create or replace function set_user_credits(p_user_id uuid, p_credits integer)
returns integer language plpgsql security definer set search_path = public as $$
begin
  insert into user_credits (user_id, credits, updated_at)
  values (p_user_id, p_credits, now())
  on conflict (user_id) do update set credits = p_credits, updated_at = now();
  return p_credits;
end; $$;

-- award_kofi gains p_is_subscription: subscription payments RESET the balance
-- to the tier amount (no rollover); one-time tips ADD (top up).
drop function if exists award_kofi(text, text, text, integer, numeric, text, text);
create or replace function award_kofi(
  p_txn_id text, p_email text, p_tier text, p_credits integer,
  p_amount numeric, p_currency text, p_type text, p_is_subscription boolean
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
    if p_is_subscription then
      perform set_user_credits(v_user, p_credits);   -- monthly reset
    else
      perform add_user_credits(v_user, p_credits);    -- one-time tip tops up
    end if;
    update kofi_transactions set redeemed_at = now(), redeemed_by_email = p_email
      where kofi_transaction_id = p_txn_id;
    return 'credited';
  else
    insert into kofi_pending_credits (email, credits, tier_name, kofi_transaction_id)
    values (p_email, p_credits, p_tier, p_txn_id);
    return 'pending';
  end if;
end; $$;

-- ── Secured redeem: apply a transaction to a SPECIFIC authenticated user_id ──
-- (No email is trusted from the request — the API derives the user from their
-- verified token, so nobody can redeem a transaction to someone else's account.)
create or replace function redeem_kofi_user(p_txn_id text, p_user_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare v_txn kofi_transactions;
begin
  select * into v_txn from kofi_transactions where kofi_transaction_id = p_txn_id;
  if v_txn is null then
    return json_build_object('success', false, 'error', 'Transaction not found');
  end if;
  if v_txn.redeemed_at is not null then
    return json_build_object('success', false, 'error', 'Already redeemed');
  end if;

  if v_txn.type = 'Subscription' then
    perform set_user_credits(p_user_id, v_txn.credits_awarded);
  else
    perform add_user_credits(p_user_id, v_txn.credits_awarded);
  end if;
  delete from kofi_pending_credits where kofi_transaction_id = p_txn_id;
  update kofi_transactions set redeemed_at = now() where kofi_transaction_id = p_txn_id;

  return json_build_object('success', true, 'credits_added', v_txn.credits_awarded);
end; $$;

grant execute on function set_user_credits(uuid, integer)                                        to service_role;
grant execute on function award_kofi(text, text, text, integer, numeric, text, text, boolean)    to service_role;
grant execute on function redeem_kofi_user(text, uuid)                                           to service_role;
