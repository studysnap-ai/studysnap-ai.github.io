-- supabase-feedback-schema.sql — 👍/👎 answer quality feedback
-- Run this in the Supabase SQL editor. Idempotent.
--
-- Purpose: every time a student rates an answer as correct or incorrect,
-- we record it here. Over time this gives us:
--   - Accuracy by question type (MCQ vs fill-in vs math)
--   - Accuracy by language (ES vs EN)
--   - Confidence calibration (do 90% confidence answers actually get 90% thumbs-up?)
--   - Which subjects / question types the AI gets wrong most often

create table if not exists feedback (
  id             uuid     primary key default gen_random_uuid(),
  user_id        uuid     references auth.users(id) on delete cascade not null,
  -- Client-generated timestamp used as the local history entry ID.
  -- Not a FK — history lives in chrome.storage, not the DB.
  entry_id       bigint   not null,
  feedback       text     not null check (feedback in ('correct', 'incorrect')),
  question_type  text,        -- mcq | truefalse | fillin | short | writing
  confidence     integer,     -- 0-100 from the AI response
  answer_snippet text,        -- first 300 chars of the answer (for debugging)
  created_at     timestamptz  default now()
);

alter table feedback enable row level security;

-- Users can only read their own feedback rows (the API writes via service role)
drop policy if exists "Users see own feedback" on feedback;
create policy "Users see own feedback"
  on feedback for select using (auth.uid() = user_id);

-- Index for per-user analytics queries
create index if not exists idx_feedback_user_id   on feedback (user_id);
-- Index for time-series analysis across all users
create index if not exists idx_feedback_created   on feedback (created_at);
-- Index for accuracy-by-question-type queries
create index if not exists idx_feedback_qtype     on feedback (question_type, feedback);

grant execute on all functions in schema public to service_role;
