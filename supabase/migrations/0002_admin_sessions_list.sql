-- Admin sessions list with player counts.
-- Admins only have column-level select on players (player_token is hidden), so
-- PostgREST's `players(count)` embed is denied. Count inside a definer function instead.
create function admin_sessions()
returns table (
  id uuid,
  code text,
  name text,
  status session_status,
  duration_seconds int,
  started_at timestamptz,
  ends_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz,
  player_count bigint
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;
  return query
    select s.id, s.code, s.name, s.status, s.duration_seconds, s.started_at, s.ends_at,
           s.ended_at, s.created_at,
           (select count(*) from players p where p.session_id = s.id)
    from sessions s
    order by s.created_at desc;
end;
$$;

revoke execute on function admin_sessions() from public, anon;
grant execute on function admin_sessions() to authenticated;
