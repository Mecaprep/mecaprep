-- MecaPrep — let a visitor read their own AI usage rows
-- --------------------------------------------------------------------------
-- Run this once in the Supabase Dashboard → SQL Editor → New query → Run.
--
-- 004_ai_usage.sql deliberately shipped with no policies at all — a
-- visitor could neither read nor write ai_usage. That was one notch too
-- strict: the scanner page needs to show "il te reste X scans ce mois-ci"
-- as soon as it loads, not only after the visitor has already done a scan
-- in that same browser session. Reading your own usage count carries no
-- monetary risk (unlike entitlements, nothing here can be self-granted),
-- so a SELECT-only policy scoped to the visitor's own rows is safe.
-- Writing stays service_role-only — no insert/update/delete policy is added.

drop policy if exists "ai_usage_select_own" on public.ai_usage;
create policy "ai_usage_select_own"
  on public.ai_usage for select
  using (auth.uid() = user_id);
