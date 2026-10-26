-- Prompt pool: a session can have 24-200 prompts; each player's board gets a random 24 of them.
-- Same function signatures as 0013 (create/update_session, join_session, start_session), so grants carry over
-- via create or replace. New error: DUPLICATE_PROMPT (case-insensitive, after trim).
-- session_stats additionally reports boards_count per prompt (how many boards carry it).

-- Pools are up to 200 prompts, so positions run 0..199 (was 0..23).
alter table session_prompts drop constraint session_prompts_position_check;
alter table session_prompts add constraint session_prompts_position_check check (position between 0 and 199);

create or replace function create_session(
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
  v_n int;
  v_domains text[];
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;
  if p_prompts is null or coalesce(array_length(p_prompts, 1), 0) not between 24 and 200 then
    raise exception 'PROMPT_COUNT';
  end if;
  v_n := array_length(p_prompts, 1);
  for i in 1..v_n loop
    v_text := btrim(coalesce(p_prompts[i], ''));
    if v_text = '' or char_length(v_text) > 120 then
      raise exception 'INVALID_INPUT' using detail = 'prompt ' || i;
    end if;
  end loop;
  if (select count(distinct lower(btrim(t))) from unnest(p_prompts) as t) <> v_n then
    raise exception 'DUPLICATE_PROMPT';
  end if;
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

  for i in 1..v_n loop
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

create or replace function update_session(
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
  v_n int;
  v_domains text[];
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;
  select * into v_session from sessions where id = p_session_id for update;
  if not found then raise exception 'SESSION_NOT_FOUND'; end if;
  if v_session.status <> 'lobby' then raise exception 'ALREADY_STARTED'; end if;

  if p_prompts is null or coalesce(array_length(p_prompts, 1), 0) not between 24 and 200 then
    raise exception 'PROMPT_COUNT';
  end if;
  v_n := array_length(p_prompts, 1);
  for i in 1..v_n loop
    v_text := btrim(coalesce(p_prompts[i], ''));
    if v_text = '' or char_length(v_text) > 120 then
      raise exception 'INVALID_INPUT' using detail = 'prompt ' || i;
    end if;
  end loop;
  if (select count(distinct lower(btrim(t))) from unnest(p_prompts) as t) <> v_n then
    raise exception 'DUPLICATE_PROMPT';
  end if;
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

  -- Replace the pool. The lobby has no claims, but check anyway before touching boards.
  if exists (select 1 from claims where session_id = p_session_id) then
    raise exception 'ALREADY_STARTED';
  end if;
  delete from boards where player_id in (select id from players where session_id = p_session_id);
  delete from session_prompts where session_id = p_session_id;
  for i in 1..v_n loop
    insert into session_prompts (session_id, text, position)
    values (p_session_id, btrim(p_prompts[i]), i - 1);
  end loop;
  -- Rebuild every joined player's board: a random 24 of the pool, shuffled, FREE at 12.
  insert into boards (player_id, cell_index, prompt_id)
  select t.player_id,
         case when t.rn - 1 >= 12 then t.rn::int else t.rn::int - 1 end,
         t.prompt_id
  from (
    select p.id as player_id, sp.id as prompt_id,
           row_number() over (partition by p.id order by random()) as rn
    from players p
    join session_prompts sp on sp.session_id = p.session_id
    where p.session_id = p_session_id
  ) t
  where t.rn <= 24;
  insert into boards (player_id, cell_index, prompt_id)
  select id, 12, null from players where session_id = p_session_id;

  return jsonb_build_object('id', p_session_id, 'code', v_session.code);
end;
$$;
revoke execute on function update_session(uuid, text, int, ranking_mode, boolean, int, int, text[], text[], int, boolean)
  from public, anon, authenticated;
grant execute on function update_session(uuid, text, int, ranking_mode, boolean, int, int, text[], text[], int, boolean)
  to authenticated;


-- join_session: only 24 of the pool per board.
create or replace function join_session(p_code text, p_full_name text, p_email text)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_session sessions;
  v_name text := btrim(coalesce(p_full_name, ''));
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_player_id uuid;
  v_token uuid;
  v_pcode text;
  v_attempt int := 0;
  v_cn text;
begin
  if v_name = '' or char_length(v_name) > 80 then
    raise exception 'INVALID_INPUT' using detail = 'full_name';
  end if;
  if v_email = '' or char_length(v_email) > 254
     or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'INVALID_INPUT' using detail = 'email';
  end if;

  -- FOR SHARE: wait for an in-progress update_session (FOR UPDATE), so a join never deals a
  -- board from a prompt pool that is being replaced, and update_session's board rebuild
  -- sees every committed player. Joins don't block each other.
  select * into v_session from sessions where code = upper(btrim(coalesce(p_code, ''))) for share;
  if not found then raise exception 'SESSION_NOT_FOUND'; end if;
  if effective_status(v_session) = 'ended' then raise exception 'SESSION_ENDED'; end if;

  if coalesce(array_length(v_session.allowed_email_domains, 1), 0) > 0
     and not (substring(v_email from '[^@]*$') = any (v_session.allowed_email_domains)) then
    raise exception 'EMAIL_DOMAIN';
  end if;

  if exists (select 1 from players where session_id = v_session.id and email = v_email) then
    raise exception 'EMAIL_TAKEN';
  end if;

  loop
    v_attempt := v_attempt + 1;
    if v_attempt > 30 then raise exception 'CODE_GENERATION_FAILED'; end if;
    v_pcode := gen_code(3) || '-' || gen_code(3);
    begin
      insert into players (session_id, full_name, email, player_code)
      values (v_session.id, v_name, v_email, v_pcode)
      returning id, player_token into v_player_id, v_token;
      exit;
    exception when unique_violation then
      get stacked diagnostics v_cn = constraint_name;
      if v_cn = 'players_session_email_key' then
        raise exception 'EMAIL_TAKEN';
      end if;
      -- player code collision: retry with a new code
    end;
  end loop;

  -- Pool: a random 24 of the session's prompts, in random order, around FREE (12).
  insert into boards (player_id, cell_index, prompt_id)
  select v_player_id,
         case when rn - 1 >= 12 then rn else rn - 1 end,
         id
  from (
    select id, row_number() over (order by random()) as rn
    from session_prompts where session_id = v_session.id
  ) t
  where rn <= 24;
  insert into boards (player_id, cell_index, prompt_id) values (v_player_id, 12, null);

  return jsonb_build_object(
    'player_id', v_player_id,
    'player_token', v_token,
    'player_code', v_pcode,
    'session_code', v_session.code
  );
end;
$$;

-- start_session: pool of at least 24.
create or replace function start_session(p_session_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_session sessions;
  v_n int;
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;
  select * into v_session from sessions where id = p_session_id for update;
  if not found then raise exception 'SESSION_NOT_FOUND'; end if;
  if v_session.status = 'ended' then raise exception 'SESSION_ENDED'; end if;
  if v_session.status = 'live' then raise exception 'ALREADY_STARTED'; end if;
  select count(*) into v_n from session_prompts where session_id = p_session_id;
  if v_n < 24 then raise exception 'PROMPT_COUNT'; end if;

  update sessions
  set status = 'live', started_at = now(), ends_at = now() + make_interval(secs => duration_seconds)
  where id = p_session_id
  returning * into v_session;
  return jsonb_build_object('started_at', v_session.started_at, 'ends_at', v_session.ends_at);
end;
$$;

-- session_stats: per-prompt boards_count (prompts appear on only some boards).
create or replace function session_stats(p_session_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_result jsonb;
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;
  if not exists (select 1 from sessions where id = p_session_id) then
    raise exception 'SESSION_NOT_FOUND';
  end if;

  with
  sess as (select started_at from sessions where id = p_session_id),
  cl as (
    select player_id, coworker_id, cell_index, status::text as status
    from claims where session_id = p_session_id
  ),
  conf as (select player_id, coworker_id from cl where status = 'confirmed'),
  per as (
    select p.id, p.full_name, p.submitted_at,
           coalesce(c.n, 0)::int as confirmed,
           case when p.submitted_at is not null and (select started_at from sess) is not null
                then greatest(_elapsed_at(p_session_id, p.submitted_at), 0)
           end as elapsed
    from players p
    left join (select player_id, count(*) as n from conf group by player_id) c on c.player_id = p.id
    where p.session_id = p_session_id
  ),
  part as (
    select count(*)::int as joined,
           count(*) filter (where confirmed >= 1)::int as active,
           count(*) filter (where submitted_at is not null)::int as submitted,
           count(*) filter (where confirmed = 24)::int as full_cards,
           coalesce(avg(confirmed), 0) as avg_conf,
           coalesce(percentile_cont(0.5) within group (order by confirmed), 0) as med_conf
    from per
  ),
  sq as (
    select count(*) filter (where status = 'confirmed')::int as confirmed,
           count(*) filter (where status = 'rejected')::int as rejected,
           count(*) filter (where status = 'expired')::int as expired
    from cl
  ),
  buckets(ord, label, lo, hi) as (
    values (1, '0', 0, 0), (2, '1-5', 1, 5), (3, '6-10', 6, 10), (4, '11-15', 11, 15),
           (5, '16-20', 16, 20), (6, '21-23', 21, 23), (7, '24', 24, 24)
  ),
  dist as (
    select b.ord, b.label, count(per.id)::int as players
    from buckets b
    left join per on per.confirmed between b.lo and b.hi
    group by b.ord, b.label
  ),
  tm as (
    select avg(elapsed) as avg_s,
           percentile_cont(0.5) within group (order by elapsed) as med_s
    from per where elapsed is not null
  ),
  fastest as (
    select full_name, elapsed from per
    where confirmed = 24 and elapsed is not null
    order by elapsed asc, full_name limit 1
  ),
  pr as (
    select sp.id, sp.text, sp.position,
           count(*) filter (where c.status = 'confirmed')::int as found_count,
           count(*) filter (where c.status = 'rejected')::int as rejected_count,
           count(distinct b.player_id)::int as boards_count
    from session_prompts sp
    left join boards b on b.prompt_id = sp.id
    left join cl c on c.player_id = b.player_id and c.cell_index = b.cell_index
    where sp.session_id = p_session_id
    group by sp.id, sp.text, sp.position
  ),
  edges as (
    select player_id as a, coworker_id as b from conf
    union all
    select coworker_id, player_id from conf
  ),
  met as (select a as player_id, count(distinct b)::int as connections from edges group by a),
  given as (select coworker_id as player_id, count(*)::int as n from conf group by coworker_id),
  top as (
    select per.full_name, met.connections, coalesce(g.n, 0) as times_confirmed_for_others
    from met
    join per on per.id = met.player_id
    left join given g on g.player_id = met.player_id
    order by met.connections desc, coalesce(g.n, 0) desc, per.full_name
    limit 10
  ),
  uniq as (select count(distinct (least(player_id, coworker_id), greatest(player_id, coworker_id)))::int as n from conf)
  select jsonb_build_object(
    'participation', (select jsonb_build_object(
        'joined', joined, 'active', active, 'submitted', submitted, 'full_cards', full_cards,
        'participation_rate', case when joined = 0 then 0 else round(active::numeric / joined, 4) end
      ) from part),
    'squares', (select jsonb_build_object(
        'confirmed', sq.confirmed, 'rejected', sq.rejected, 'expired', sq.expired,
        'avg_confirmed_per_player', round(part.avg_conf::numeric, 2),
        'median_confirmed_per_player', round(part.med_conf::numeric, 2),
        'distribution', (select jsonb_agg(jsonb_build_object('label', label, 'players', players) order by ord) from dist)
      ) from sq, part),
    'timing', (select jsonb_build_object(
        'avg_elapsed_seconds', round(avg_s::numeric, 1),
        'median_elapsed_seconds', round(med_s::numeric, 1),
        'fastest_full_card', (select jsonb_build_object('name', full_name, 'seconds', round(elapsed::numeric, 1)) from fastest)
      ) from tm),
    'prompts', coalesce((select jsonb_agg(jsonb_build_object(
        'prompt_id', id, 'text', text, 'position', position,
        'found_count', found_count, 'rejected_count', rejected_count,
        'boards_count', boards_count,
        'rejection_rate', case when found_count + rejected_count = 0 then 0
                               else round(rejected_count::numeric / (found_count + rejected_count), 4) end
      ) order by found_count desc, position) from pr), '[]'::jsonb),
    'people', jsonb_build_object(
      'top_connected', coalesce((select jsonb_agg(jsonb_build_object(
          'name', full_name, 'connections', connections,
          'times_confirmed_for_others', times_confirmed_for_others
        ) order by connections desc, times_confirmed_for_others desc, full_name) from top), '[]'::jsonb),
      'total_unique_connections', (select n from uniq)
    )
  ) into v_result;

  return v_result;
end;
$$;
