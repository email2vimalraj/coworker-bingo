-- 0013: per-session switch for filling a square by username/email.
--   * sessions.allow_username_claims (default true). When false, create_claim only accepts a
--     player code / QR URL; email and username input raise COWORKER_NOT_FOUND.
--   * The gate lives in _resolve_coworker (create_claim and its lock order are unchanged).
--   * create_session / update_session gain a trailing p_allow_username_claims (default true).
--   * player_poll session object gains require_full_card and allow_username_claims.

alter table sessions add column allow_username_claims boolean not null default true;

create or replace function _resolve_coworker(p_session_id uuid, p_input text) returns uuid
language plpgsql stable set search_path = public as $$
declare
  v_input text := btrim(coalesce(p_input, ''));
  v_code text;
  v_id uuid;
  v_n int;
  v_allow boolean;
begin
  if v_input = '' then raise exception 'COWORKER_NOT_FOUND'; end if;

  -- 1. player code (or QR URL with ?c=)
  v_code := normalize_player_code(v_input);
  if v_code is not null then
    select id into v_id from players
    where session_id = p_session_id and player_code = v_code;
    if found then return v_id; end if;
  end if;

  -- Username / email lookups can be switched off per session.
  select allow_username_claims into v_allow from sessions where id = p_session_id;
  if not coalesce(v_allow, true) then raise exception 'COWORKER_NOT_FOUND'; end if;

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

drop function create_session(text, int, ranking_mode, boolean, int, int, text[], text[], int);
create function create_session(
  p_name text,
  p_duration_seconds int,
  p_ranking_mode ranking_mode,
  p_require_full_card boolean,
  p_winners_count int,
  p_max_squares_per_coworker int,
  p_prompts text[],
  p_allowed_email_domains text[] default '{}',
  p_lines_to_win int default 1,
  p_allow_username_claims boolean default true
) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_id uuid;
  v_code text;
  v_attempt int := 0;
  i int;
  v_text text;
  v_domains text[];
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;
  if p_prompts is null or coalesce(array_length(p_prompts, 1), 0) <> 24 then
    raise exception 'PROMPT_COUNT';
  end if;
  for i in 1..24 loop
    v_text := btrim(coalesce(p_prompts[i], ''));
    if v_text = '' or char_length(v_text) > 120 then
      raise exception 'INVALID_INPUT' using detail = 'prompt ' || i;
    end if;
  end loop;
  if btrim(coalesce(p_name, '')) = '' or char_length(btrim(p_name)) > 100
     or p_duration_seconds is null
     or p_duration_seconds < 30 or p_duration_seconds > 28800
     or coalesce(p_winners_count, 0) < 1
     or coalesce(p_max_squares_per_coworker, 0) < 1
     or coalesce(p_lines_to_win, 1) not between 1 and 12 then
    raise exception 'INVALID_INPUT';
  end if;
  v_domains := _normalize_domains(p_allowed_email_domains);

  loop
    v_attempt := v_attempt + 1;
    if v_attempt > 30 then raise exception 'CODE_GENERATION_FAILED'; end if;
    v_code := gen_code(6);
    exit when not exists (select 1 from sessions where code = v_code);
  end loop;

  insert into sessions (code, name, duration_seconds, ranking_mode, require_full_card,
                        winners_count, max_squares_per_coworker, allowed_email_domains,
                        lines_to_win, allow_username_claims, created_by)
  values (v_code, btrim(p_name), p_duration_seconds, coalesce(p_ranking_mode, 'correct_then_time'),
          coalesce(p_require_full_card, false), p_winners_count, p_max_squares_per_coworker,
          v_domains, coalesce(p_lines_to_win, 1), coalesce(p_allow_username_claims, true), auth.uid())
  returning id into v_id;

  for i in 1..24 loop
    insert into session_prompts (session_id, text, position)
    values (v_id, btrim(p_prompts[i]), i - 1);
  end loop;

  return jsonb_build_object('id', v_id, 'code', v_code);
end;
$$;

revoke execute on function create_session(text, int, ranking_mode, boolean, int, int, text[], text[], int, boolean)
  from public, anon, authenticated;
grant execute on function create_session(text, int, ranking_mode, boolean, int, int, text[], text[], int, boolean)
  to authenticated;

drop function update_session(uuid, text, int, ranking_mode, boolean, int, int, text[], text[], int);
create function update_session(
  p_session_id uuid,
  p_name text,
  p_duration_seconds int,
  p_ranking_mode ranking_mode,
  p_require_full_card boolean,
  p_winners_count int,
  p_max_squares_per_coworker int,
  p_allowed_email_domains text[],
  p_prompts text[],
  p_lines_to_win int default 1,
  p_allow_username_claims boolean default true
) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_session sessions;
  i int;
  v_text text;
  v_domains text[];
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;
  select * into v_session from sessions where id = p_session_id for update;
  if not found then raise exception 'SESSION_NOT_FOUND'; end if;
  if v_session.status <> 'lobby' then raise exception 'ALREADY_STARTED'; end if;

  if p_prompts is null or coalesce(array_length(p_prompts, 1), 0) <> 24 then
    raise exception 'PROMPT_COUNT';
  end if;
  for i in 1..24 loop
    v_text := btrim(coalesce(p_prompts[i], ''));
    if v_text = '' or char_length(v_text) > 120 then
      raise exception 'INVALID_INPUT' using detail = 'prompt ' || i;
    end if;
  end loop;
  if btrim(coalesce(p_name, '')) = '' or char_length(btrim(p_name)) > 100
     or p_duration_seconds is null
     or p_duration_seconds < 30 or p_duration_seconds > 28800
     or coalesce(p_winners_count, 0) < 1
     or coalesce(p_max_squares_per_coworker, 0) < 1
     or coalesce(p_lines_to_win, 1) not between 1 and 12 then
    raise exception 'INVALID_INPUT';
  end if;
  v_domains := _normalize_domains(p_allowed_email_domains);

  update sessions
  set name = btrim(p_name),
      duration_seconds = p_duration_seconds,
      ranking_mode = coalesce(p_ranking_mode, 'correct_then_time'),
      require_full_card = coalesce(p_require_full_card, false),
      winners_count = p_winners_count,
      max_squares_per_coworker = p_max_squares_per_coworker,
      allowed_email_domains = v_domains,
      lines_to_win = coalesce(p_lines_to_win, 1),
      allow_username_claims = coalesce(p_allow_username_claims, true)
  where id = p_session_id;

  for i in 1..24 loop
    update session_prompts set text = btrim(p_prompts[i])
    where session_id = p_session_id and position = i - 1;
  end loop;

  return jsonb_build_object('id', p_session_id, 'code', v_session.code);
end;
$$;
revoke execute on function update_session(uuid, text, int, ranking_mode, boolean, int, int, text[], text[], int, boolean)
  from public, anon, authenticated;
grant execute on function update_session(uuid, text, int, ranking_mode, boolean, int, int, text[], text[], int, boolean)
  to authenticated;

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
      'require_full_card', v_session.require_full_card,
      'allow_username_claims', v_session.allow_username_claims,
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
