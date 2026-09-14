-- MecaPrep — quiz history (so a visitor can find quizzes they already did)
-- --------------------------------------------------------------------------
-- Run this once in the Supabase Dashboard → SQL Editor → New query → Run,
-- same as 001_entitlements.sql.
--
-- One row per finished quiz attempt. Unlike entitlements, this table has
-- no monetary value attached to it (writing a fake score here can't grant
-- premium or credits), so — unlike entitlements — the signed-in visitor is
-- allowed to insert their own rows directly from the browser: no Edge
-- Function or service_role needed.

create table if not exists public.quiz_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  theme_key text not null,
  title text not null,
  score integer not null,
  total integer not null,
  answers jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists quiz_attempts_user_id_created_at_idx
  on public.quiz_attempts (user_id, created_at desc);

alter table public.quiz_attempts enable row level security;

drop policy if exists "quiz_attempts_select_own" on public.quiz_attempts;
create policy "quiz_attempts_select_own"
  on public.quiz_attempts for select
  using (auth.uid() = user_id);

drop policy if exists "quiz_attempts_insert_own" on public.quiz_attempts;
create policy "quiz_attempts_insert_own"
  on public.quiz_attempts for insert
  with check (auth.uid() = user_id);

-- Deliberately no update/delete policy: an attempt is an immutable record
-- of something that actually happened.
