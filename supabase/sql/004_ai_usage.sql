-- MecaPrep — AI usage ledger (scanner + chat)
-- --------------------------------------------------------------------------
-- Run this once in the Supabase Dashboard → SQL Editor → New query → Run.
--
-- One row per call to Claude made by the analyze-scan / ai-chat Edge
-- Functions. It is what enforces, server-side and per ACCOUNT (not per
-- browser, so clearing localStorage no longer gives a new free scan):
--   · the single free scan an account gets (a row with billing = 'free')
--   · the daily caps that keep one account from running up the AI bill
-- `billing` records how the call was paid for:
--   'free'    the account's one free scan
--   'credit'  one credit was spent
--   'premium' included in the subscription
--   'none'    not charged (the call failed or found no usable theme, so
--             any credit was refunded) — still counts toward daily caps
--
-- Written only by the Edge Functions (service_role). RLS on with no
-- policies: a visitor can neither read nor write it from the browser.

create table if not exists public.ai_usage (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('scan', 'chat')),
  billing text not null check (billing in ('free', 'credit', 'premium', 'none')),
  created_at timestamptz not null default now()
);

create index if not exists ai_usage_user_kind_created_idx
  on public.ai_usage (user_id, kind, created_at desc);

alter table public.ai_usage enable row level security;
