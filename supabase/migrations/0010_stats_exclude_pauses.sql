-- Post-event stats: exclude paused time from players' elapsed times (consistent with ranking).
-- 0009 was written in parallel with pause/resume (0006), so it used plain submitted_at - started_at.
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
           count(*) filter (where c.status = 'rejected')::int as rejected_count
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
