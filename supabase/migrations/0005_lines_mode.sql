-- Item 6: classic bingo "lines" ranking mode, configurable per session.
--
-- Lines: 5 rows, 5 columns, 2 diagonals (12). The FREE centre (cell 12) counts as filled,
-- so a line is complete when all its NON-FREE cells have a confirmed claim.
-- Line completion time = latest resolved_at among its confirmed claims.
-- Reach time = the moment the player's Nth line completed (N = lines_to_win), in seconds since
-- started_at (via _elapsed_at, which migration 0006 makes pause-aware).
--
-- Ranking in 'lines' mode (mirrored in lib/ranking.ts + lib/lines.ts):
--   eligible  = correct >= 1 and lines >= lines_to_win
--   order     = eligible first by reach_seconds asc, then joined_at;
--               then non-eligible by lines desc, correct desc, elapsed asc, joined_at
--   ties share a rank (equal reach for eligible; equal lines/correct/elapsed otherwise)
--   winners   = top winners_count eligible. require_full_card is ignored.
-- NOTE: enum literals for the new value are compared as text because a value added by
-- ALTER TYPE cannot be used in the same transaction.

alter type ranking_mode add value 'lines';
alter table sessions add column lines_to_win int not null default 1
  check (lines_to_win between 1 and 12);

-- Seconds since started_at at moment p_at. (0006 replaces this with a pause-aware version.)
create function _elapsed_at(p_session_id uuid, p_at timestamptz) returns double precision
language sql stable set search_path = public as $$
  select extract(epoch from (p_at - s.started_at))::double precision
  from sessions s where s.id = p_session_id;
$$;
revoke execute on function _elapsed_at(uuid, timestamptz) from public, anon, authenticated;

-- The 12 lines over cells 0..24 (row-major, FREE = 12). `cells` excludes the FREE cell.
create function _bingo_lines() returns table (idx int, cells int[], need int)
language sql immutable set search_path = public as $$
  with raw(idx, c) as (
    select r, array_agg(r * 5 + k order by k) from generate_series(0, 4) r, generate_series(0, 4) k group by r
    union all
    select 5 + k, array_agg(r * 5 + k order by r) from generate_series(0, 4) r, generate_series(0, 4) k group by k
    union all
    select 10, array_agg(i * 6 order by i) from generate_series(0, 4) i
    union all
    select 11, array_agg(i * 4 + 4 order by i) from generate_series(0, 4) i
  )
  select idx, array_remove(c, 12), cardinality(array_remove(c, 12)) from raw;
$$;
revoke execute on function _bingo_lines() from public, anon, authenticated;

drop function session_leaderboard(uuid);
drop function _leaderboard(uuid);

create function _leaderboard(p_session_id uuid)
returns table (
  player_id uuid,
  full_name text,
  email text,
  correct int,
  elapsed_seconds double precision,
  submitted_at timestamptz,
  eligible boolean,
  rank int,
  is_winner boolean,
  prize_rank int,
  lines int,
  reach_seconds double precision
)
language sql stable set search_path = public as $$
  with s as (select * from sessions where id = p_session_id),
  lc as (
    select c.player_id, l.idx, max(coalesce(c.resolved_at, c.created_at)) as done_at
    from s
    join _bingo_lines() l on s.ranking_mode::text = 'lines'
    join claims c on c.session_id = s.id and c.status = 'confirmed' and c.cell_index = any (l.cells)
    group by c.player_id, l.idx, l.need
    having count(*) = l.need
  ),
  lr as (
    select lc.player_id, count(*)::int as lines,
      (array_agg(lc.done_at order by lc.done_at))[(select lines_to_win from s)] as reach_at
    from lc group by lc.player_id
  ),
  base as (
    select p.id, p.full_name, p.email::text as email, p.joined_at, p.submitted_at,
      coalesce((select count(*) from claims c
                where c.player_id = p.id and c.status = 'confirmed'), 0)::int as correct,
      case when p.submitted_at is not null and s.started_at is not null
           then _elapsed_at(s.id, p.submitted_at)
           else s.duration_seconds::double precision end as elapsed,
      s.ranking_mode, s.require_full_card, s.winners_count, s.lines_to_win,
      coalesce(lr.lines, 0) as lines,
      case when lr.reach_at is not null then _elapsed_at(s.id, lr.reach_at) end as reach
    from players p cross join s
    left join lr on lr.player_id = p.id
    where p.session_id = p_session_id
  ),
  flagged as (
    select b.*,
      (b.correct >= 1 and
       case when b.ranking_mode::text = 'lines' then b.lines >= b.lines_to_win
            when b.require_full_card or b.ranking_mode::text = 'full_card_fastest'
            then b.correct = 24 else true end) as eligible,
      case when b.ranking_mode::text = 'full_card_fastest'
           then b.correct = 24 else true end as ranked
    from base b
  ),
  keyed as (
    select f.*,
      (f.ranking_mode::text = 'lines') as is_lines,
      case when f.ranking_mode::text = 'lines' and not f.eligible then 1 else 0 end as k_grp
    from flagged f
  ),
  sorted as (
    select k.*,
      case when k.is_lines and k.eligible then k.reach else 0 end as k_reach,
      case when k.is_lines and not k.eligible then -k.lines else 0 end as k_lines,
      case when k.is_lines and k.eligible then 0 else -k.correct end as k_correct,
      case when k.is_lines and k.eligible then 0 else k.elapsed end as k_elapsed
    from keyed k
  ),
  scored as (
    select f.*,
      case when f.ranked then
        rank() over (partition by f.ranked
                     order by f.k_grp, f.k_reach, f.k_lines, f.k_correct, f.k_elapsed)
      end as rnk,
      row_number() over (partition by f.eligible
                         order by f.k_grp, f.k_reach, f.k_lines, f.k_correct, f.k_elapsed,
                                  f.joined_at asc) as pos
    from sorted f
  )
  select sc.id, sc.full_name, sc.email, sc.correct, sc.elapsed, sc.submitted_at,
    sc.eligible,
    sc.rnk::int,
    (sc.eligible and sc.pos <= sc.winners_count),
    case when sc.eligible and sc.pos <= sc.winners_count then sc.rnk::int end,
    sc.lines,
    case when sc.is_lines and sc.eligible then sc.reach end
  from scored sc
  order by sc.k_grp, sc.k_reach, sc.k_lines, sc.k_correct, sc.k_elapsed, sc.joined_at asc;
$$;
revoke execute on function _leaderboard(uuid) from public, anon, authenticated;

create function session_leaderboard(p_session_id uuid)
returns table (
  player_id uuid,
  full_name text,
  email text,
  correct int,
  elapsed_seconds double precision,
  submitted_at timestamptz,
  eligible boolean,
  rank int,
  is_winner boolean,
  prize_rank int,
  lines int,
  reach_seconds double precision
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;
  return query select * from _leaderboard(p_session_id);
end;
$$;
revoke execute on function session_leaderboard(uuid) from public, anon, authenticated;
grant execute on function session_leaderboard(uuid) to authenticated;

-- player_poll: adds session.ranking_mode / lines_to_win, me.lines, result.lines / reach_seconds.
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

  -- Lazy expiry: pending claims older than 2 minutes, or any once the game is over.
  update claims set status = 'expired', resolved_at = now()
  where status = 'pending'
    and (player_id = v_player.id or coworker_id = v_player.id)
    and (created_at < now() - interval '2 minutes' or v_status = 'ended');

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
      'lines_to_win', v_session.lines_to_win
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

-- create_session / update_session gain p_lines_to_win (trailing, default 1; 1..12).
drop function create_session(text, int, ranking_mode, boolean, int, int, text[], text[]);
create function create_session(
  p_name text,
  p_duration_seconds int,
  p_ranking_mode ranking_mode,
  p_require_full_card boolean,
  p_winners_count int,
  p_max_squares_per_coworker int,
  p_prompts text[],
  p_allowed_email_domains text[] default '{}',
  p_lines_to_win int default 1
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
  if btrim(coalesce(p_name, '')) = '' or p_duration_seconds is null
     or p_duration_seconds < 30 or coalesce(p_winners_count, 0) < 1
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
                        lines_to_win, created_by)
  values (v_code, btrim(p_name), p_duration_seconds, coalesce(p_ranking_mode, 'correct_then_time'),
          coalesce(p_require_full_card, false), p_winners_count, p_max_squares_per_coworker,
          v_domains, coalesce(p_lines_to_win, 1), auth.uid())
  returning id into v_id;

  for i in 1..24 loop
    insert into session_prompts (session_id, text, position)
    values (v_id, btrim(p_prompts[i]), i - 1);
  end loop;

  return jsonb_build_object('id', v_id, 'code', v_code);
end;
$$;
revoke execute on function create_session(text, int, ranking_mode, boolean, int, int, text[], text[], int)
  from public, anon, authenticated;
grant execute on function create_session(text, int, ranking_mode, boolean, int, int, text[], text[], int)
  to authenticated;

drop function update_session(uuid, text, int, ranking_mode, boolean, int, int, text[], text[]);
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
  p_lines_to_win int default 1
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
      lines_to_win = coalesce(p_lines_to_win, 1)
  where id = p_session_id;

  for i in 1..24 loop
    update session_prompts set text = btrim(p_prompts[i])
    where session_id = p_session_id and position = i - 1;
  end loop;

  return jsonb_build_object('id', p_session_id, 'code', v_session.code);
end;
$$;
revoke execute on function update_session(uuid, text, int, ranking_mode, boolean, int, int, text[], text[], int)
  from public, anon, authenticated;
grant execute on function update_session(uuid, text, int, ranking_mode, boolean, int, int, text[], text[], int)
  to authenticated;
