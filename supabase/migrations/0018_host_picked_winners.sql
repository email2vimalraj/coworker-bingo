-- Host-picked winners (0018): after the game ends the host can award prize places that the ranking
-- rules left empty (e.g. require_full_card and nobody at 24/24). Picks are a layer on top of the rules:
-- the automatic winners and every rank stay exactly as before.
--   players.award_place        the place the host gave (1..winners_count), unique per session
--   _leaderboard / session_leaderboard   + award_place, host_pick, prize_place; is_winner is also true for picks
--   admin_award_prize / admin_clear_prize
--   player_poll                result also has host_pick and prize_place
alter table players add column award_place smallint check (award_place >= 1);
create unique index players_session_award_place_key on players (session_id, award_place)
  where award_place is not null;
-- Column-level grant like the other non-token columns, so admin dashboards can read it and Realtime
-- on players carries it. player_token stays ungranted.
grant select (award_place) on players to authenticated;

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
  reach_seconds double precision,
  award_place int,
  host_pick boolean,
  prize_place int
)
language sql stable set search_path = public as $$
  with s as (select * from sessions where id = p_session_id),
  -- Pauses loaded once (usually 0-3 rows) so per-player elapsed math is inline, not a function call.
  pz as (select sp.started_at, sp.ended_at from session_pauses sp where sp.session_id = p_session_id),
  lc as (
    select c.player_id, l.idx, max(coalesce(c.resolved_at, c.created_at)) as done_at
    from s
    join _bingo_lines() l on s.ranking_mode::text = 'lines'
    join claims c on c.session_id = s.id and c.status = 'confirmed' and c.cell_index = any (l.cells)
    where (select ranking_mode::text from s) = 'lines'  -- skip entirely in the other modes
    group by c.player_id, l.idx, l.need
    having count(*) = l.need
  ),
  lr as (
    select lc.player_id, count(*)::int as lines,
      (array_agg(lc.done_at order by lc.done_at))[(select lines_to_win from s)] as reach_at
    from lc group by lc.player_id
  ),
  -- MATERIALIZED so the per-player claim count and pause math are computed once, not re-inlined
  -- into every expression below that references them.
  base as materialized (
    select p.id, p.full_name, p.email::text as email, p.joined_at, p.submitted_at, p.award_place::int as award_place,
      coalesce((select count(*) from claims c
                where c.player_id = p.id and c.status = 'confirmed'), 0)::int as correct,
      case when p.submitted_at is not null and s.started_at is not null
           then extract(epoch from (p.submitted_at - s.started_at))::double precision - pe_sub.secs
           else s.duration_seconds::double precision end as elapsed,
      s.ranking_mode, s.require_full_card, s.winners_count, s.lines_to_win,
      coalesce(lr.lines, 0) as lines,
      case when lr.reach_at is not null then extract(epoch from (lr.reach_at - s.started_at))::double precision - pe_reach.secs end as reach
    from players p cross join s
    left join lr on lr.player_id = p.id
    -- Paused seconds overlapping [started_at, moment]; an open pause counts up to the moment.
    -- Same arithmetic as _paused_seconds() / _elapsed_at().
    left join lateral (
      select coalesce(sum(extract(epoch from greatest(interval '0',
               least(coalesce(pz.ended_at, p.submitted_at), p.submitted_at) - greatest(pz.started_at, s.started_at)))), 0)::double precision as secs
      from pz where p.submitted_at is not null
    ) pe_sub on true
    left join lateral (
      select coalesce(sum(extract(epoch from greatest(interval '0',
               least(coalesce(pz.ended_at, lr.reach_at), lr.reach_at) - greatest(pz.started_at, s.started_at)))), 0)::double precision as secs
      from pz where lr.reach_at is not null
    ) pe_reach on true
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
    (sc.eligible and sc.pos <= sc.winners_count) or sc.award_place is not null,
    case when sc.eligible and sc.pos <= sc.winners_count then sc.rnk::int end,
    sc.lines,
    case when sc.is_lines and sc.eligible then sc.reach end,
    sc.award_place,
    (sc.award_place is not null and not (sc.eligible and sc.pos <= sc.winners_count)),
    case when sc.eligible and sc.pos <= sc.winners_count then sc.pos::int else sc.award_place end
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
  reach_seconds double precision,
  award_place int,
  host_pick boolean,
  prize_place int
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;
  return query select * from _leaderboard(p_session_id);
end;
$$;
revoke execute on function session_leaderboard(uuid) from public, anon, authenticated;
grant execute on function session_leaderboard(uuid) to authenticated;

-- Awards the lowest free place (or p_place) among k+1..winners_count, k = automatic winners.
create function admin_award_prize(p_player_id uuid, p_place int default null)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_session_id uuid;
  v_session sessions;
  v_k int;
  v_place int;
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;
  select session_id into v_session_id from players where id = p_player_id;
  if not found then raise exception 'PLAYER_NOT_FOUND'; end if;
  -- Serialise concurrent awards for this session.
  select * into v_session from sessions where id = v_session_id for update;
  if effective_status(v_session) <> 'ended' then raise exception 'NOT_ENDED'; end if;
  -- The player may have been removed while we waited for the lock.
  perform 1 from players where id = p_player_id;
  if not found then raise exception 'PLAYER_NOT_FOUND'; end if;

  select count(*)::int into v_k from _leaderboard(v_session_id) l where l.is_winner and not l.host_pick;
  if exists (select 1 from _leaderboard(v_session_id) l where l.player_id = p_player_id and l.is_winner) then
    raise exception 'ALREADY_WINNER';
  end if;

  if p_place is null then
    select min(g) into v_place from generate_series(v_k + 1, v_session.winners_count) g
    where not exists (select 1 from players p where p.session_id = v_session_id and p.award_place = g);
    if v_place is null then raise exception 'NO_FREE_PLACE'; end if;
  else
    if p_place < v_k + 1 or p_place > v_session.winners_count then raise exception 'INVALID_PLACE'; end if;
    if exists (select 1 from players p where p.session_id = v_session_id and p.award_place = p_place) then
      raise exception 'PLACE_TAKEN';
    end if;
    v_place := p_place;
  end if;

  update players set award_place = v_place where id = p_player_id;
  return jsonb_build_object('player_id', p_player_id, 'place', v_place);
end;
$$;
revoke execute on function admin_award_prize(uuid, int) from public, anon;
grant execute on function admin_award_prize(uuid, int) to authenticated;

create function admin_clear_prize(p_player_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_session_id uuid;
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;
  select session_id into v_session_id from players where id = p_player_id;
  if not found then raise exception 'PLAYER_NOT_FOUND'; end if;
  perform 1 from sessions where id = v_session_id for update;
  update players set award_place = null where id = p_player_id;
  return jsonb_build_object('player_id', p_player_id, 'cleared', true);
end;
$$;
revoke execute on function admin_clear_prize(uuid) from public, anon;
grant execute on function admin_clear_prize(uuid) to authenticated;

-- player_poll: result also carries host_pick and prize_place (the player's place, automatic or picked).
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
      'reach_seconds', v_lb.reach_seconds,
      'host_pick', v_lb.host_pick,
      'prize_place', v_lb.prize_place
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
