-- 0012: fill a square by the coworker's username (the part of the email before '@').
--   * _resolve_coworker(session, input): player code (incl. QR URLs) -> full email -> username.
--   * USERNAME_AMBIGUOUS when a username matches more than one player in the session.
--   * create_claim uses it (lock order unchanged: scanner's players row first, then claims).
--   * player_poll: me.username (own username only; nobody else's email is exposed).

create index players_session_username_idx
  on players (session_id, lower(split_part(email::text, '@', 1)));

create function _resolve_coworker(p_session_id uuid, p_input text) returns uuid
language plpgsql stable set search_path = public as $$
declare
  v_input text := btrim(coalesce(p_input, ''));
  v_code text;
  v_id uuid;
  v_n int;
begin
  if v_input = '' then raise exception 'COWORKER_NOT_FOUND'; end if;

  -- 1. player code (or QR URL with ?c=)
  v_code := normalize_player_code(v_input);
  if v_code is not null then
    select id into v_id from players
    where session_id = p_session_id and player_code = v_code;
    if found then return v_id; end if;
  end if;

  -- 2. full email
  if position('@' in v_input) > 0 then
    select id into v_id from players
    where session_id = p_session_id and email = v_input::citext;
    if not found then raise exception 'COWORKER_NOT_FOUND'; end if;
    return v_id;
  end if;

  -- 3. username
  select count(*), min(id::text)::uuid into v_n, v_id from players
  where session_id = p_session_id
    and lower(split_part(email::text, '@', 1)) = lower(v_input);
  if v_n = 0 then raise exception 'COWORKER_NOT_FOUND'; end if;
  if v_n > 1 then raise exception 'USERNAME_AMBIGUOUS'; end if;
  return v_id;
end;
$$;

revoke execute on function _resolve_coworker(uuid, text) from public, anon, authenticated;

create or replace function create_claim(p_token uuid, p_cell_index int, p_coworker_code text)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_player players;
  v_session sessions;
  v_cw players;
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

  select * into v_cw from players
  where id = _resolve_coworker(v_player.session_id, p_coworker_code);
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
      and cl.status in ('rejected', 'expired', 'revoked')
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
      'username', lower(split_part(v_player.email::text, '@', 1)),
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
