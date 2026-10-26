-- Item 7: extend time and pause/resume.
--
-- New error codes: PAUSED (claims blocked while paused), ALREADY_PAUSED, NOT_PAUSED.
--
-- Model: sessions.paused_at is set while paused; every pause is also logged in session_pauses
-- (started_at, ended_at null while open). While paused:
--   * effective status stays 'live'; a paused session never counts as ended by time
--   * create_claim / respond_claim / cancel_claim raise PAUSED; submit_board is still allowed
--   * ends_at is left untouched; resume_session pushes ends_at forward by the pause length
--   * pending claims do not age (see _claim_expired)
-- Elapsed time for ranking (all modes, incl. lines reach time) excludes the pause time that
-- overlaps [started_at, moment] (see _elapsed_at). Mirrored in lib/ranking.ts (cfg.pauses).

alter table sessions add column paused_at timestamptz;

create table session_pauses (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions (id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);
create index session_pauses_session_idx on session_pauses (session_id);
create unique index session_pauses_one_open on session_pauses (session_id) where ended_at is null;

alter table session_pauses enable row level security;
create policy session_pauses_admin on session_pauses for select to authenticated
  using (is_admin());
revoke all on session_pauses from anon, authenticated;
grant select on session_pauses to authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- A paused live session is never ended by time.
create or replace function effective_status(s sessions) returns text
language sql stable set search_path = public as $$
  select case
    when s.status = 'ended' then 'ended'
    when s.status = 'live' and s.paused_at is null and now() > s.ends_at then 'ended'
    else s.status::text
  end;
$$;

-- Seconds of pause overlapping [p_from, p_to]. An open pause counts up to p_to.
create function _paused_seconds(p_session_id uuid, p_from timestamptz, p_to timestamptz)
returns double precision
language sql stable set search_path = public as $$
  select coalesce(sum(extract(epoch from greatest(
      interval '0',
      least(coalesce(sp.ended_at, p_to), p_to) - greatest(sp.started_at, p_from)))), 0)::double precision
  from session_pauses sp where sp.session_id = p_session_id;
$$;
revoke execute on function _paused_seconds(uuid, timestamptz, timestamptz) from public, anon, authenticated;

-- Seconds since started_at at moment p_at, minus paused time (replaces the 0005 version).
create or replace function _elapsed_at(p_session_id uuid, p_at timestamptz) returns double precision
language sql stable set search_path = public as $$
  select extract(epoch from (p_at - s.started_at))::double precision
         - _paused_seconds(s.id, s.started_at, p_at)
  from sessions s where s.id = p_session_id;
$$;

-- A pending claim expires after 2 minutes of non-paused time.
create function _claim_expired(p_session_id uuid, p_created_at timestamptz) returns boolean
language sql stable set search_path = public as $$
  select extract(epoch from (now() - p_created_at))
         - _paused_seconds(p_session_id, p_created_at, now()) > 120;
$$;
revoke execute on function _claim_expired(uuid, timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Player RPCs
-- ---------------------------------------------------------------------------
create or replace function player_poll(p_token uuid) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_player players;
  v_session sessions;
  v_status text;
  v_board jsonb;
  v_incoming jsonb;
  v_result jsonb := null;
  v_correct int;
  v_lines int := 0;
  v_lb record;
begin
  select * into v_player from players where player_token = p_token;
  if not found then raise exception 'INVALID_TOKEN'; end if;
  select * into v_session from sessions where id = v_player.session_id;
  v_status := effective_status(v_session);

  -- Lazy expiry: pending claims older than 2 minutes (pauses don't count), or any once the game is over.
  update claims set status = 'expired', resolved_at = now()
  where status = 'pending'
    and (player_id = v_player.id or coworker_id = v_player.id)
    and (_claim_expired(session_id, created_at) or v_status = 'ended');

  select coalesce(jsonb_agg(jsonb_build_object(
      'cell_index', b.cell_index,
      'prompt_id', b.prompt_id,
      'prompt', sp.text,
      'is_free', b.prompt_id is null,
      'status', c.status::text,
      'claim_id', c.id,
      'coworker_name', cw.full_name,
      'last_outcome', lo.status::text,
      'last_outcome_name', lo.name
    ) order by b.cell_index), '[]'::jsonb)
  into v_board
  from boards b
  left join session_prompts sp on sp.id = b.prompt_id
  left join lateral (
    select cl.id, cl.status, cl.coworker_id from claims cl
    where cl.player_id = b.player_id and cl.cell_index = b.cell_index
      and cl.status in ('pending', 'confirmed')
  ) c on true
  left join players cw on cw.id = c.coworker_id
  left join lateral (
    select cl.status, p2.full_name as name from claims cl
    join players p2 on p2.id = cl.coworker_id
    where c.id is null and cl.player_id = b.player_id and cl.cell_index = b.cell_index
      and cl.status in ('rejected', 'expired')
    order by cl.created_at desc limit 1
  ) lo on true
  where b.player_id = v_player.id;

  select coalesce(jsonb_agg(jsonb_build_object(
      'claim_id', c.id,
      'from_name', p.full_name,
      'prompt', sp.text,
      'cell_index', c.cell_index,
      'created_at', c.created_at
    ) order by c.created_at), '[]'::jsonb)
  into v_incoming
  from claims c
  join players p on p.id = c.player_id
  join boards b on b.player_id = c.player_id and b.cell_index = c.cell_index
  join session_prompts sp on sp.id = b.prompt_id
  where c.coworker_id = v_player.id and c.status = 'pending';

  select count(*)::int into v_correct from claims
  where player_id = v_player.id and status = 'confirmed';

  if v_session.ranking_mode::text = 'lines' then
    select count(*)::int into v_lines
    from _bingo_lines() l
    where l.need = (select count(*) from claims c
                    where c.player_id = v_player.id and c.status = 'confirmed'
                      and c.cell_index = any (l.cells));
  end if;

  if v_status = 'ended' then
    select * into v_lb from _leaderboard(v_session.id) l where l.player_id = v_player.id;
    v_result := jsonb_build_object(
      'correct', v_lb.correct,
      'elapsed_seconds', v_lb.elapsed_seconds,
      'rank', v_lb.rank,
      'is_winner', v_lb.is_winner,
      'prize_rank', v_lb.prize_rank,
      'lines', v_lb.lines,
      'reach_seconds', v_lb.reach_seconds
    );
  end if;

  return jsonb_build_object(
    'session', jsonb_build_object(
      'code', v_session.code,
      'name', v_session.name,
      'status', v_status,
      'started_at', v_session.started_at,
      'ends_at', v_session.ends_at,
      'duration_seconds', v_session.duration_seconds,
      'winners_count', v_session.winners_count,
      'max_squares_per_coworker', v_session.max_squares_per_coworker,
      'ranking_mode', v_session.ranking_mode::text,
      'lines_to_win', v_session.lines_to_win,
      'paused', (v_status = 'live' and v_session.paused_at is not null),
      'paused_at', case when v_status = 'live' then v_session.paused_at end
    ),
    'server_now', now(),
    'me', jsonb_build_object(
      'id', v_player.id,
      'full_name', v_player.full_name,
      'player_code', v_player.player_code,
      'submitted_at', v_player.submitted_at,
      'correct', v_correct,
      'lines', v_lines
    ),
    'board', v_board,
    'incoming', v_incoming,
    'result', v_result
  );
end;
$$;

create or replace function create_claim(p_token uuid, p_cell_index int, p_coworker_code text)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_player players;
  v_session sessions;
  v_cw players;
  v_code text;
  v_claim_id uuid;
  v_count int;
begin
  -- Lock the scanner row to serialize this player's claim attempts.
  select * into v_player from players where player_token = p_token for update;
  if not found then raise exception 'INVALID_TOKEN'; end if;
  select * into v_session from sessions where id = v_player.session_id;

  if p_cell_index is null or p_cell_index < 0 or p_cell_index > 24 or p_cell_index = 12 then
    raise exception 'INVALID_INPUT' using detail = 'cell_index';
  end if;

  if v_session.status = 'lobby' then raise exception 'NOT_LIVE'; end if;
  if v_session.status = 'ended' then raise exception 'SESSION_ENDED'; end if;
  if v_session.paused_at is not null then raise exception 'PAUSED'; end if;
  if now() > v_session.ends_at then raise exception 'TIME_UP'; end if;
  if v_player.submitted_at is not null then raise exception 'ALREADY_SUBMITTED'; end if;

  v_code := normalize_player_code(p_coworker_code);
  if v_code is null then raise exception 'COWORKER_NOT_FOUND'; end if;
  select * into v_cw from players
  where session_id = v_player.session_id and player_code = v_code;
  if not found then raise exception 'COWORKER_NOT_FOUND'; end if;
  if v_cw.id = v_player.id then raise exception 'SELF_SCAN'; end if;

  -- Expire stale pending claims of this player so they free their cells.
  update claims set status = 'expired', resolved_at = now()
  where player_id = v_player.id and status = 'pending'
    and _claim_expired(session_id, created_at);

  select count(*) into v_count from claims
  where player_id = v_player.id and coworker_id = v_cw.id
    and status in ('pending', 'confirmed');
  if v_count >= v_session.max_squares_per_coworker then
    raise exception 'COWORKER_LIMIT';
  end if;

  if exists (select 1 from claims where player_id = v_player.id
             and cell_index = p_cell_index and status in ('pending', 'confirmed')) then
    raise exception 'CELL_TAKEN';
  end if;

  begin
    insert into claims (session_id, player_id, coworker_id, cell_index)
    values (v_player.session_id, v_player.id, v_cw.id, p_cell_index)
    returning id into v_claim_id;
  exception when unique_violation then
    raise exception 'CELL_TAKEN';
  end;

  return jsonb_build_object('claim_id', v_claim_id, 'coworker_name', v_cw.full_name);
end;
$$;

create or replace function respond_claim(p_token uuid, p_claim_id uuid, p_accept boolean)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_me players;
  v_claim claims;
  v_session sessions;
  v_scanner players;
  v_count int;
  v_new claim_status;
begin
  select * into v_me from players where player_token = p_token;
  if not found then raise exception 'INVALID_TOKEN'; end if;
  if p_accept is null then raise exception 'INVALID_INPUT' using detail = 'accept'; end if;

  -- Lock order is always scanner (players row) then claim, same as create_claim and
  -- submit_board, so concurrent confirmations for one scanner serialize without deadlock.
  select * into v_claim from claims where id = p_claim_id;
  if not found then raise exception 'CLAIM_NOT_FOUND'; end if;
  if v_claim.coworker_id <> v_me.id then raise exception 'NOT_YOURS'; end if;
  select * into v_scanner from players where id = v_claim.player_id for update;
  select * into v_claim from claims where id = p_claim_id for update;
  if not found then raise exception 'CLAIM_NOT_FOUND'; end if;

  select * into v_session from sessions where id = v_claim.session_id;
  if v_session.status = 'ended' then raise exception 'SESSION_ENDED'; end if;
  if v_session.status = 'live' and v_session.paused_at is not null then
    raise exception 'PAUSED';
  end if;
  if v_session.status = 'live' and now() > v_session.ends_at then
    raise exception 'TIME_UP';
  end if;

  if v_claim.status <> 'pending' then raise exception 'CLAIM_NOT_PENDING'; end if;
  if _claim_expired(v_claim.session_id, v_claim.created_at) then
    raise exception 'CLAIM_NOT_PENDING';
  end if;

  if p_accept then
    if v_scanner.submitted_at is not null then raise exception 'ALREADY_SUBMITTED'; end if;
    if exists (select 1 from claims where player_id = v_claim.player_id
               and cell_index = v_claim.cell_index and id <> v_claim.id
               and status in ('pending', 'confirmed')) then
      raise exception 'CELL_TAKEN';
    end if;
    select count(*) into v_count from claims
    where player_id = v_claim.player_id and coworker_id = v_claim.coworker_id
      and id <> v_claim.id and status = 'confirmed';
    if v_count + 1 > v_session.max_squares_per_coworker then
      raise exception 'COWORKER_LIMIT';
    end if;
    v_new := 'confirmed';
  else
    v_new := 'rejected';
  end if;

  update claims set status = v_new, resolved_at = now() where id = v_claim.id;
  return jsonb_build_object('claim_id', v_claim.id, 'status', v_new::text);
end;
$$;

create or replace function cancel_claim(p_token uuid, p_claim_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_me players;
  v_claim claims;
  v_session sessions;
begin
  select * into v_me from players where player_token = p_token;
  if not found then raise exception 'INVALID_TOKEN'; end if;
  perform 1 from players where id = v_me.id for update;
  select * into v_claim from claims where id = p_claim_id for update;
  if not found then raise exception 'CLAIM_NOT_FOUND'; end if;
  if v_claim.player_id <> v_me.id then raise exception 'NOT_YOURS'; end if;
  select * into v_session from sessions where id = v_claim.session_id;
  if v_session.status = 'live' and v_session.paused_at is not null then
    raise exception 'PAUSED';
  end if;
  if v_claim.status <> 'pending' then raise exception 'CLAIM_NOT_PENDING'; end if;
  delete from claims where id = v_claim.id;
  return jsonb_build_object('claim_id', p_claim_id, 'cancelled', true);
end;
$$;

-- submit_board stays allowed while paused (the elapsed time excludes the pause).
create or replace function submit_board(p_token uuid) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_player players;
  v_session sessions;
  v_correct int;
  v_now timestamptz := now();
begin
  select * into v_player from players where player_token = p_token for update;
  if not found then raise exception 'INVALID_TOKEN'; end if;
  select * into v_session from sessions where id = v_player.session_id;
  if v_player.submitted_at is not null then raise exception 'ALREADY_SUBMITTED'; end if;
  if v_session.status = 'lobby' then raise exception 'NOT_LIVE'; end if;
  if v_session.status = 'ended' then raise exception 'SESSION_ENDED'; end if;
  if v_session.paused_at is null and v_now > v_session.ends_at then
    raise exception 'TIME_UP';
  end if;

  update players set submitted_at = v_now where id = v_player.id;
  update claims set status = 'expired', resolved_at = v_now
  where player_id = v_player.id and status = 'pending';
  select count(*)::int into v_correct from claims
  where player_id = v_player.id and status = 'confirmed';

  return jsonb_build_object('submitted_at', v_now, 'correct', v_correct);
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin RPCs
-- ---------------------------------------------------------------------------
-- end_session works while paused: the open pause is closed and ends_at becomes now().
create or replace function end_session(p_session_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_session sessions;
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;
  select * into v_session from sessions where id = p_session_id for update;
  if not found then raise exception 'SESSION_NOT_FOUND'; end if;
  if v_session.status = 'ended' then raise exception 'SESSION_ENDED'; end if;

  update session_pauses set ended_at = now()
  where session_id = p_session_id and ended_at is null;

  update sessions
  set status = 'ended', ended_at = now(), paused_at = null,
      ends_at = case when v_session.paused_at is not null then now()
                     else least(coalesce(ends_at, now()), now()) end
  where id = p_session_id
  returning * into v_session;
  update claims set status = 'expired', resolved_at = now()
  where session_id = p_session_id and status = 'pending';
  return jsonb_build_object('ended_at', v_session.ended_at, 'ends_at', v_session.ends_at);
end;
$$;

create function pause_session(p_session_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_session sessions;
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;
  select * into v_session from sessions where id = p_session_id for update;
  if not found then raise exception 'SESSION_NOT_FOUND'; end if;
  if v_session.status = 'lobby' then raise exception 'NOT_LIVE'; end if;
  if v_session.status = 'ended' then raise exception 'SESSION_ENDED'; end if;
  if v_session.paused_at is not null then raise exception 'ALREADY_PAUSED'; end if;
  if now() > v_session.ends_at then raise exception 'SESSION_ENDED'; end if;

  update sessions set paused_at = now() where id = p_session_id
  returning * into v_session;
  insert into session_pauses (session_id, started_at) values (p_session_id, v_session.paused_at);
  return jsonb_build_object('paused_at', v_session.paused_at, 'ends_at', v_session.ends_at);
end;
$$;

create function resume_session(p_session_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_session sessions;
  v_now timestamptz := now();
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;
  select * into v_session from sessions where id = p_session_id for update;
  if not found then raise exception 'SESSION_NOT_FOUND'; end if;
  if v_session.status = 'ended' then raise exception 'SESSION_ENDED'; end if;
  if v_session.status <> 'live' or v_session.paused_at is null then
    raise exception 'NOT_PAUSED';
  end if;

  update session_pauses set ended_at = v_now
  where session_id = p_session_id and ended_at is null;
  update sessions
  set ends_at = ends_at + (v_now - paused_at), paused_at = null
  where id = p_session_id
  returning * into v_session;
  return jsonb_build_object('ends_at', v_session.ends_at);
end;
$$;

-- Adds time to a live or paused session that hasn't ended yet.
create function extend_session(p_session_id uuid, p_seconds int) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_session sessions;
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;
  if p_seconds is null or p_seconds < 1 or p_seconds > 3600 then
    raise exception 'INVALID_INPUT' using detail = 'seconds';
  end if;
  select * into v_session from sessions where id = p_session_id for update;
  if not found then raise exception 'SESSION_NOT_FOUND'; end if;
  if v_session.status = 'lobby' then raise exception 'NOT_LIVE'; end if;
  if v_session.status = 'ended' then raise exception 'SESSION_ENDED'; end if;
  if v_session.paused_at is null and now() > v_session.ends_at then
    raise exception 'SESSION_ENDED';
  end if;
  if v_session.duration_seconds + p_seconds > 28800 then
    raise exception 'INVALID_INPUT' using detail = 'seconds';
  end if;

  update sessions
  set ends_at = ends_at + make_interval(secs => p_seconds),
      duration_seconds = duration_seconds + p_seconds
  where id = p_session_id
  returning * into v_session;
  return jsonb_build_object('ends_at', v_session.ends_at, 'duration_seconds', v_session.duration_seconds);
end;
$$;

revoke execute on function pause_session(uuid) from public, anon, authenticated;
revoke execute on function resume_session(uuid) from public, anon, authenticated;
revoke execute on function extend_session(uuid, int) from public, anon, authenticated;
grant execute on function pause_session(uuid) to authenticated;
grant execute on function resume_session(uuid) to authenticated;
grant execute on function extend_session(uuid, int) to authenticated;

-- admin_sessions gains paused_at so the sessions list doesn't show a paused game as ended.
drop function admin_sessions();
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
  player_count bigint,
  paused_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;
  return query
    select s.id, s.code, s.name, s.status, s.duration_seconds, s.started_at, s.ends_at,
           s.ended_at, s.created_at,
           (select count(*) from players p where p.session_id = s.id),
           s.paused_at
    from sessions s
    order by s.created_at desc;
end;
$$;
revoke execute on function admin_sessions() from public, anon, authenticated;
grant execute on function admin_sessions() to authenticated;
