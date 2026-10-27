-- 0016: admin_db_health() for the end-to-end load test (scripts/load-e2e.ts).
-- Admin-only, aggregate numbers only: no query texts, usernames or client addresses.
-- Each part is read in its own exception block, so a stat the hosting role cannot read
-- is reported in "unavailable" instead of failing the whole call.
create function admin_db_health() returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v jsonb := '{}'::jsonb;
  v_unavailable text[] := '{}';
  r record;
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;

  begin
    select
      count(*) filter (where state = 'active')::int as active,
      count(*) filter (where state = 'idle')::int as idle,
      count(*) filter (where state like 'idle in transaction%')::int as idle_in_tx,
      count(*) filter (where state is null or state not in ('active', 'idle') and state not like 'idle in transaction%')::int as other,
      count(*)::int as total,
      count(*) filter (where wait_event_type = 'Lock')::int as waiting_locks,
      coalesce(max(extract(epoch from (now() - query_start))) filter (where state = 'active'), 0)::float8 as longest_active_s
    into r
    from pg_stat_activity
    where datname = current_database() and pid <> pg_backend_pid()
      and backend_type = 'client backend'; -- skips walsender (replication slots look 'active' forever)
    v := v || jsonb_build_object(
      'conn_active', r.active, 'conn_idle', r.idle, 'conn_idle_in_tx', r.idle_in_tx,
      'conn_other', r.other, 'conn_total', r.total,
      'waiting_locks', r.waiting_locks, 'longest_active_s', round(r.longest_active_s::numeric, 3));
  exception when others then
    v_unavailable := v_unavailable || 'pg_stat_activity';
  end;

  begin
    select xact_commit, xact_rollback, deadlocks, blks_hit, blks_read, temp_bytes
    into r from pg_stat_database where datname = current_database();
    v := v || jsonb_build_object(
      'xact_commit', r.xact_commit, 'xact_rollback', r.xact_rollback, 'deadlocks', r.deadlocks,
      'blks_hit', r.blks_hit, 'blks_read', r.blks_read, 'temp_bytes', r.temp_bytes);
  exception when others then
    v_unavailable := v_unavailable || 'pg_stat_database';
  end;

  begin
    v := v || jsonb_build_object('db_size_bytes', pg_database_size(current_database()));
  exception when others then
    v_unavailable := v_unavailable || 'pg_database_size';
  end;

  begin
    v := v || jsonb_build_object('max_connections', current_setting('max_connections')::int);
  exception when others then
    v_unavailable := v_unavailable || 'max_connections';
  end;

  return v || jsonb_build_object('unavailable', to_jsonb(v_unavailable), 'sampled_at', now());
end;
$$;

revoke execute on function admin_db_health() from public, anon, authenticated;
grant execute on function admin_db_health() to authenticated;
