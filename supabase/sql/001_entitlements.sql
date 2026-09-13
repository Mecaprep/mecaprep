-- MecaPrep — entitlements (real, server-verified premium status & credits)
-- --------------------------------------------------------------------------
-- Run this once in the Supabase Dashboard → SQL Editor → New query → Run.
--
-- One row per authenticated user. This table REPLACES localStorage as the
-- source of truth for premium/credits: it's only ever written by the
-- stripe-webhook Edge Function (using the service_role key, server-side),
-- after Stripe actually confirms a payment. A signed-in visitor can read
-- their own row (so the app can show the right state) but can NEVER write
-- to it directly — otherwise anyone could grant themselves premium with a
-- single REST call from the browser console.

create table if not exists public.entitlements (
  user_id uuid primary key references auth.users(id) on delete cascade,
  premium boolean not null default false,
  credits integer not null default 0,
  stripe_customer_id text,
  updated_at timestamptz not null default now()
);

alter table public.entitlements enable row level security;

drop policy if exists "entitlements_select_own" on public.entitlements;
create policy "entitlements_select_own"
  on public.entitlements for select
  using (auth.uid() = user_id);

-- Deliberately NO insert/update/delete policy for anon/authenticated roles.
-- Only the service_role key (used exclusively inside the stripe-webhook
-- Edge Function, never shipped to the browser) can write to this table.

-- ---------------------------------------------------------------------
-- Webhook idempotency: Stripe can and does deliver the same event more
-- than once (retries on any non-2xx, or just duplicate delivery). Without
-- this guard a replayed "checkout.session.completed" for a one-off credit
-- purchase would grant the credit twice. The webhook inserts the Stripe
-- event id here BEFORE doing anything else; a conflict means "already
-- handled" and the function returns immediately.
-- ---------------------------------------------------------------------
create table if not exists public.stripe_events (
  id text primary key,
  created_at timestamptz not null default now()
);
alter table public.stripe_events enable row level security;
-- no policies at all: only service_role (which bypasses RLS) ever touches it.

-- Additive credit top-up (one-off purchase). Safe to call at most once per
-- Stripe event thanks to the stripe_events guard above.
create or replace function public.grant_credit(p_user_id uuid, p_amount integer)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.entitlements (user_id, credits)
  values (p_user_id, p_amount)
  on conflict (user_id)
  do update set credits = public.entitlements.credits + excluded.credits,
                updated_at = now();
$$;

-- Sets premium on/off. Touches ONLY the premium column — deliberately
-- separate from set_stripe_customer below, so recording a customer id
-- can never accidentally flip someone's premium status.
create or replace function public.set_premium(p_user_id uuid, p_premium boolean)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.entitlements (user_id, premium)
  values (p_user_id, p_premium)
  on conflict (user_id)
  do update set premium = excluded.premium,
                updated_at = now();
$$;

-- Atomically spends one credit (used to unlock a locked theme, or an
-- extra scan). The WHERE guard makes this safe to call concurrently from
-- two tabs without ever taking credits negative: if the row doesn't have
-- at least p_amount credits, zero rows match and nothing is deducted.
-- Returns the credits remaining, or null if there weren't enough.
create or replace function public.spend_credit(p_user_id uuid, p_amount integer default 1)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_remaining integer;
begin
  update public.entitlements
     set credits = credits - p_amount,
         updated_at = now()
   where user_id = p_user_id and credits >= p_amount
  returning credits into v_remaining;
  return v_remaining; -- null if the guard didn't match (not enough credits)
end;
$$;

-- Records the Stripe customer id for a user. Touches ONLY that column.
create or replace function public.set_stripe_customer(p_user_id uuid, p_stripe_customer_id text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.entitlements (user_id, stripe_customer_id)
  values (p_user_id, p_stripe_customer_id)
  on conflict (user_id)
  do update set stripe_customer_id = excluded.stripe_customer_id,
                updated_at = now();
$$;

-- Reverse lookup used when a subscription is cancelled: Stripe's
-- "customer.subscription.deleted" event only carries the Stripe customer
-- id, not the Supabase user id, so the webhook needs this to know whose
-- premium flag to clear.
create or replace function public.user_id_for_stripe_customer(p_stripe_customer_id text)
returns uuid
language sql
security definer
set search_path = public
stable
as $$
  select user_id from public.entitlements where stripe_customer_id = p_stripe_customer_id limit 1;
$$;

-- ---------------------------------------------------------------------
-- CRITICAL: lock every one of the functions above down to service_role.
-- `security definer` makes them run with elevated rights, which is exactly
-- why they must NEVER be callable straight from the browser: without this,
-- any signed-in visitor could open devtools and run, say,
--   supabase.rpc('set_premium', { p_user_id: '<their-own-id>', p_premium: true })
-- and grant themselves premium for free, with no Stripe payment involved.
-- Only the Edge Functions (which use the service_role key, server-side
-- only) may call these. Supabase grants EXECUTE on new functions to
-- PUBLIC by default, so this revoke is not optional.
-- ---------------------------------------------------------------------
revoke execute on function public.grant_credit(uuid, integer) from public, anon, authenticated;
revoke execute on function public.set_premium(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.spend_credit(uuid, integer) from public, anon, authenticated;
revoke execute on function public.set_stripe_customer(uuid, text) from public, anon, authenticated;
revoke execute on function public.user_id_for_stripe_customer(text) from public, anon, authenticated;

grant execute on function public.grant_credit(uuid, integer) to service_role;
grant execute on function public.set_premium(uuid, boolean) to service_role;
grant execute on function public.spend_credit(uuid, integer) to service_role;
grant execute on function public.set_stripe_customer(uuid, text) to service_role;
grant execute on function public.user_id_for_stripe_customer(text) to service_role;
