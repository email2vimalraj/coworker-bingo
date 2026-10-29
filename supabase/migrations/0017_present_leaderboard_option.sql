-- 0017: per-session switch for the live Top 10 on the Present (projector) screen.
-- Off by default, so the projector doesn't give away who is winning before the reveal.
-- Admins change it from the dashboard with a plain table update (sessions_admin policy),
-- at any time, including during a live game; the Present screen picks it up via Realtime.
alter table sessions add column present_show_leaderboard boolean not null default false;
