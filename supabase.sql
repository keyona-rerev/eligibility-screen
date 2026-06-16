-- Eligibility Quick Screen: lead + result table (T033)
-- Lives in the existing online-report-card Supabase project (shared with T028/T030/T031/T032),
-- so SUPABASE_URL and SUPABASE_SERVICE_KEY are already valid. Already applied live.

create table if not exists eligibility_reports (
  id          bigint generated always as identity primary key,
  created_at  timestamptz default now(),
  full_name   text not null,
  email       text not null,
  division    text,           -- DI or DII
  core_done   int,            -- core courses completed (0-16)
  core_gpa    numeric,
  grad_year   int,
  verdict     text,
  report      jsonb,          -- full card the page renders
  ip          text,           -- used only for rate limiting
  token       text unique     -- unguessable id for the shareable /report.html page
);

create index if not exists eligibility_created_idx on eligibility_reports (created_at desc);
create index if not exists eligibility_cache_idx   on eligibility_reports (email, division, core_gpa, created_at desc);
create index if not exists eligibility_ip_idx      on eligibility_reports (ip, created_at desc);

-- Lock the table down. The server uses the service-role key, which bypasses RLS.
alter table eligibility_reports enable row level security;
