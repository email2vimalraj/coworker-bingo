-- Shows which migration files have been applied to this database.
-- Run it in the Supabase SQL editor, then run only the files marked "not applied", in order.
select m.file,
       case when m.applied then 'applied' else 'NOT applied - run this file' end as status
from (values
  ('0001_init.sql',                  to_regtype('public.session_status') is not null),
  ('0002_admin_sessions_list.sql',   to_regprocedure('public.admin_sessions()') is not null),
  ('0003_allowed_email_domains.sql', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sessions' and column_name = 'allowed_email_domains')),
  ('0004_update_session.sql',        exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'update_session')),
  ('0005_lines_mode.sql',            exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sessions' and column_name = 'lines_to_win')),
  ('0006_pause_extend.sql',          to_regclass('public.session_pauses') is not null),
  ('0007_admin_player_controls.sql', to_regprocedure('public.admin_revoke_claim(uuid)') is not null),
  ('0008_manage_admins.sql',         to_regprocedure('public.admin_list()') is not null),
  ('0009_session_stats.sql',         to_regprocedure('public.session_stats(uuid)') is not null),
  ('0010_stats_exclude_pauses.sql',  coalesce((select prosrc like '%_elapsed_at%' from pg_proc where oid = to_regprocedure('public.session_stats(uuid)')), false)),
  ('0011_review_fixes.sql',          coalesce((select prosrc ilike '%get diagnostics%' from pg_proc where oid = to_regprocedure('public.admin_remove(uuid)')), false)),
  ('0012_claim_by_username.sql',     to_regprocedure('public._resolve_coworker(uuid,text)') is not null),
  ('0013_username_option.sql',      exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sessions' and column_name = 'allow_username_claims')),
  ('0014_prompt_pool.sql',          coalesce((select prosrc like '%DUPLICATE_PROMPT%' from pg_proc where oid = to_regprocedure('public.update_session(uuid,text,integer,ranking_mode,boolean,integer,integer,text[],text[],integer,boolean)')), false)),
  ('0015_admin_create_account.sql',  to_regprocedure('public.admin_create(text,text)') is not null)
) as m(file, applied)
order by m.file;
