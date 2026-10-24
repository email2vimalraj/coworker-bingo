-- Coworker Bingo: initial schema, RLS and RPCs.
-- Run in the Supabase SQL editor (or `supabase db push`).
--
-- Error codes raised by RPCs (message of the exception, stable for UI mapping):
--   INVALID_INPUT, EMAIL_TAKEN, SESSION_NOT_FOUND, SESSION_ENDED, NOT_LIVE,
--   TIME_UP, ALREADY_SUBMITTED, SELF_SCAN, COWORKER_NOT_FOUND, COWORKER_LIMIT,
--   CELL_TAKEN, NOT_YOURS, INVALID_TOKEN, CLAIM_NOT_FOUND, CLAIM_NOT_PENDING,
--   NOT_ADMIN, PROMPT_COUNT, ALREADY_STARTED, CODE_GENERATION_FAILED

create extension if not exists citext with schema public;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type session_status as enum ('lobby', 'live', 'ended');
create type ranking_mode as enum ('correct_then_time', 'full_card_fastest');
create type claim_status as enum ('pending', 'confirmed', 'rejected', 'expired');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null check (char_length(btrim(name)) between 1 and 100),
  duration_seconds int not null check (duration_seconds between 30 and 28800),
  status session_status not null default 'lobby',
  started_at timestamptz,
  ends_at timestamptz,
  ended_at timestamptz,
  ranking_mode ranking_mode not null default 'correct_then_time',
  require_full_card boolean not null default false,
  winners_count int not null default 3 check (winners_count >= 1),
  max_squares_per_coworker int not null default 1 check (max_squares_per_coworker >= 1),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create table session_prompts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions (id) on delete cascade,
  text text not null check (char_length(btrim(text)) between 1 and 120),
  position int not null check (position between 0 and 23),
  unique (session_id, position)
);

create table players (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions (id) on delete cascade,
  full_name text not null check (char_length(btrim(full_name)) between 1 and 80),
  email citext not null check (char_length(email::text) <= 254),
  player_code text not null,
  player_token uuid not null default gen_random_uuid(),
  joined_at timestamptz not null default now(),
  submitted_at timestamptz,
  constraint players_session_email_key unique (session_id, email),
  constraint players_session_code_key unique (session_id, player_code),
  constraint players_token_key unique (player_token)
);

create table boards (
  player_id uuid not null references players (id) on delete cascade,
  cell_index int not null check (cell_index between 0 and 24),
  prompt_id uuid references session_prompts (id) on delete cascade,
  primary key (player_id, cell_index),
  check ((cell_index = 12) = (prompt_id is null))
);

create table claims (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions (id) on delete cascade,
  player_id uuid not null references players (id) on delete cascade,
  coworker_id uuid not null references players (id) on delete cascade,
  cell_index int not null check (cell_index between 0 and 24 and cell_index <> 12),
  status claim_status not null default 'pending',
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  check (player_id <> coworker_id)
);

-- Indexes (poll path + integrity)
create unique index claims_one_active_per_cell
  on claims (player_id, cell_index) where status in ('pending', 'confirmed');
create index claims_player_idx on claims (player_id);
create index claims_coworker_status_idx on claims (coworker_id, status);
create index claims_session_status_idx on claims (session_id, status);
create index players_session_idx on players (session_id);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from admins where user_id = auth.uid());
$$;

-- Effective status: a live session whose ends_at has passed counts as ended.
create function effective_status(s sessions) returns text
language sql stable set search_path = public as $$
  select case
    when s.status = 'ended' then 'ended'
    when s.status = 'live' and now() > s.ends_at then 'ended'
    else s.status::text
  end;
$$;

-- Random code from an alphabet without 0, O, 1, I, L.
create function gen_code(p_len int) returns text
language plpgsql volatile set search_path = public as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  r text := '';
  i int;
begin
  for i in 1..p_len loop
    r := r || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  end loop;
  return r;
end;
$$;

-- Normalizes a coworker code. Accepts "qx7-4pm", "QX74PM", or a full URL
-- containing "c=<code>". Returns 'XXX-XXX' or null if it can't be a code.
create function normalize_player_code(p_input text) returns text
language plpgsql immutable set search_path = public as $$
declare
  v text := coalesce(p_input, '');
  m text[];
begin
  m := regexp_match(v, '[?&]c=([^&#\s]+)', 'i');
  if m is not null then
    v := m[1];
  end if;
  v := upper(regexp_replace(v, '[^A-Za-z0-9]', '', 'g'));
  if char_length(v) <> 6 then
    return null;
  end if;
  return substr(v, 1, 3) || '-' || substr(v, 4, 3);
end;
$$;

-- Internal ranking. Not granted to any client role.
-- Rules (mirrored in lib/ranking.ts):
--   correct   = confirmed claims made by the player
--   elapsed   = submitted_at - started_at, else full duration_seconds
--   eligible  = can win: correct >= 1, and correct = 24 if require_full_card or mode full_card_fastest
--   rank      = competition rank (ties share) by correct desc, elapsed asc;
--               in full_card_fastest only 24/24 boards are ranked (others null)
--   is_winner = eligible and position (correct desc, elapsed asc, joined_at) <= winners_count
--   prize_rank= rank for winners, else null
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
  prize_rank int
)
language sql stable set search_path = public as $$
  with s as (select * from sessions where id = p_session_id),
  base as (
    select p.id, p.full_name, p.email::text as email, p.joined_at, p.submitted_at,
      coalesce((select count(*) from claims c
                where c.player_id = p.id and c.status = 'confirmed'), 0)::int as correct,
      case when p.submitted_at is not null and s.started_at is not null
           then extract(epoch from (p.submitted_at - s.started_at))::double precision
           else s.duration_seconds::double precision end as elapsed,
      s.ranking_mode, s.require_full_card, s.winners_count
    from players p cross join s
    where p.session_id = p_session_id
  ),
  flagged as (
    select b.*,
      (b.correct >= 1 and
       case when b.require_full_card or b.ranking_mode = 'full_card_fastest'
            then b.correct = 24 else true end) as eligible,
      case when b.ranking_mode = 'full_card_fastest'
           then b.correct = 24 else true end as ranked
    from base b
  ),
  scored as (
    select f.*,
      case when f.ranked then
        rank() over (partition by f.ranked order by f.correct desc, f.elapsed asc)
      end as rnk,
      row_number() over (partition by f.eligible
                         order by f.correct desc, f.elapsed asc, f.joined_at asc) as pos
    from flagged f
  )
  select sc.id, sc.full_name, sc.email, sc.correct, sc.elapsed, sc.submitted_at,
    sc.eligible,
    sc.rnk::int,
    (sc.eligible and sc.pos <= sc.winners_count),
    case when sc.eligible and sc.pos <= sc.winners_count then sc.rnk::int end
  from scored sc
  order by sc.correct desc, sc.elapsed asc, sc.joined_at asc;
$$;

-- ---------------------------------------------------------------------------
-- Player RPCs (anon allowed)
-- ---------------------------------------------------------------------------
create function join_session(p_code text, p_full_name text, p_email text)
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

  select * into v_session from sessions where code = upper(btrim(coalesce(p_code, '')));
  if not found then raise exception 'SESSION_NOT_FOUND'; end if;
  if effective_status(v_session) = 'ended' then raise exception 'SESSION_ENDED'; end if;

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

  -- Shuffled board: 24 prompts around the FREE centre cell (12).
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

create function player_poll(p_token uuid) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_player players;
  v_session sessions;
  v_status text;
  v_board jsonb;
  v_incoming jsonb;
  v_result jsonb := null;
  v_correct int;
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

  if v_status = 'ended' then
    select * into v_lb from _leaderboard(v_session.id) l where l.player_id = v_player.id;
    v_result := jsonb_build_object(
      'correct', v_lb.correct,
      'elapsed_seconds', v_lb.elapsed_seconds,
      'rank', v_lb.rank,
      'is_winner', v_lb.is_winner,
      'prize_rank', v_lb.prize_rank
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
      'max_squares_per_coworker', v_session.max_squares_per_coworker
    ),
    'server_now', now(),
    'me', jsonb_build_object(
      'id', v_player.id,
      'full_name', v_player.full_name,
      'player_code', v_player.player_code,
      'submitted_at', v_player.submitted_at,
      'correct', v_correct
    ),
    'board', v_board,
    'incoming', v_incoming,
    'result', v_result
  );
end;
$$;

create function create_claim(p_token uuid, p_cell_index int, p_coworker_code text)
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
    and created_at < now() - interval '2 minutes';

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

create function respond_claim(p_token uuid, p_claim_id uuid, p_accept boolean)
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
  if v_session.status = 'live' and now() > v_session.ends_at then
    raise exception 'TIME_UP';
  end if;

  if v_claim.status <> 'pending' then raise exception 'CLAIM_NOT_PENDING'; end if;
  if v_claim.created_at < now() - interval '2 minutes' then
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

-- Scanner cancels their own pending claim. The row is deleted so it leaves no trace.
create function cancel_claim(p_token uuid, p_claim_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_me players;
  v_claim claims;
begin
  select * into v_me from players where player_token = p_token;
  if not found then raise exception 'INVALID_TOKEN'; end if;
  perform 1 from players where id = v_me.id for update;
  select * into v_claim from claims where id = p_claim_id for update;
  if not found then raise exception 'CLAIM_NOT_FOUND'; end if;
  if v_claim.player_id <> v_me.id then raise exception 'NOT_YOURS'; end if;
  if v_claim.status <> 'pending' then raise exception 'CLAIM_NOT_PENDING'; end if;
  delete from claims where id = v_claim.id;
  return jsonb_build_object('claim_id', p_claim_id, 'cancelled', true);
end;
$$;

create function submit_board(p_token uuid) returns jsonb
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
  if v_now > v_session.ends_at then raise exception 'TIME_UP'; end if;

  update players set submitted_at = v_now where id = v_player.id;
  update claims set status = 'expired', resolved_at = v_now
  where player_id = v_player.id and status = 'pending';
  select count(*)::int into v_correct from claims
  where player_id = v_player.id and status = 'confirmed';

  return jsonb_build_object('submitted_at', v_now, 'correct', v_correct);
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin RPCs (authenticated + is_admin())
-- ---------------------------------------------------------------------------
create function create_session(
  p_name text,
  p_duration_seconds int,
  p_ranking_mode ranking_mode,
  p_require_full_card boolean,
  p_winners_count int,
  p_max_squares_per_coworker int,
  p_prompts text[]
) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_id uuid;
  v_code text;
  v_attempt int := 0;
  i int;
  v_text text;
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
     or coalesce(p_max_squares_per_coworker, 0) < 1 then
    raise exception 'INVALID_INPUT';
  end if;

  loop
    v_attempt := v_attempt + 1;
    if v_attempt > 30 then raise exception 'CODE_GENERATION_FAILED'; end if;
    v_code := gen_code(6);
    exit when not exists (select 1 from sessions where code = v_code);
  end loop;

  insert into sessions (code, name, duration_seconds, ranking_mode, require_full_card,
                        winners_count, max_squares_per_coworker, created_by)
  values (v_code, btrim(p_name), p_duration_seconds, coalesce(p_ranking_mode, 'correct_then_time'),
          coalesce(p_require_full_card, false), p_winners_count, p_max_squares_per_coworker,
          auth.uid())
  returning id into v_id;

  for i in 1..24 loop
    insert into session_prompts (session_id, text, position)
    values (v_id, btrim(p_prompts[i]), i - 1);
  end loop;

  return jsonb_build_object('id', v_id, 'code', v_code);
end;
$$;

create function start_session(p_session_id uuid) returns jsonb
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
  if v_n <> 24 then raise exception 'PROMPT_COUNT'; end if;

  update sessions
  set status = 'live', started_at = now(), ends_at = now() + make_interval(secs => duration_seconds)
  where id = p_session_id
  returning * into v_session;
  return jsonb_build_object('started_at', v_session.started_at, 'ends_at', v_session.ends_at);
end;
$$;

create function end_session(p_session_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_session sessions;
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;
  select * into v_session from sessions where id = p_session_id for update;
  if not found then raise exception 'SESSION_NOT_FOUND'; end if;
  if v_session.status = 'ended' then raise exception 'SESSION_ENDED'; end if;

  update sessions
  set status = 'ended', ended_at = now(), ends_at = least(coalesce(ends_at, now()), now())
  where id = p_session_id
  returning * into v_session;
  update claims set status = 'expired', resolved_at = now()
  where session_id = p_session_id and status = 'pending';
  return jsonb_build_object('ended_at', v_session.ended_at, 'ends_at', v_session.ends_at);
end;
$$;

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
  prize_rank int
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;
  return query select * from _leaderboard(p_session_id);
end;
$$;

-- Server clock for admin timers (players get server_now from player_poll).
create function server_now() returns timestamptz
language sql stable set search_path = public as $$ select now(); $$;

-- Latest confirmed claims with the prompt text, for the admin activity feed.
create function session_activity(p_session_id uuid, p_limit int default 20)
returns table (
  id uuid,
  cell_index int,
  player_name text,
  coworker_name text,
  prompt text,
  resolved_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;
  return query
    select c.id, c.cell_index, p.full_name, cw.full_name, sp.text, c.resolved_at
    from claims c
    join players p on p.id = c.player_id
    join players cw on cw.id = c.coworker_id
    left join boards b on b.player_id = c.player_id and b.cell_index = c.cell_index
    left join session_prompts sp on sp.id = b.prompt_id
    where c.session_id = p_session_id and c.status = 'confirmed'
    order by c.resolved_at desc nulls last
    limit least(greatest(coalesce(p_limit, 20), 1), 100);
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS: anon gets nothing; admins get everything via is_admin().
-- ---------------------------------------------------------------------------
alter table admins enable row level security;
alter table sessions enable row level security;
alter table session_prompts enable row level security;
alter table players enable row level security;
alter table boards enable row level security;
alter table claims enable row level security;

create policy admins_self_read on admins for select to authenticated
  using (user_id = auth.uid());
create policy sessions_admin on sessions for all to authenticated
  using (is_admin()) with check (is_admin());
create policy session_prompts_admin on session_prompts for all to authenticated
  using (is_admin()) with check (is_admin());
create policy players_admin on players for all to authenticated
  using (is_admin()) with check (is_admin());
create policy boards_admin on boards for all to authenticated
  using (is_admin()) with check (is_admin());
create policy claims_admin on claims for all to authenticated
  using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
grant select, insert, update, delete on sessions, session_prompts, boards, claims
  to authenticated;
-- players: no access to player_token (a bearer secret) for anyone but its owner,
-- admins included. Admins can read everything else and delete; rows are created by join_session.
grant select (id, session_id, full_name, email, player_code, joined_at, submitted_at),
  delete on players to authenticated;
grant select on admins to authenticated;

revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function is_admin() to authenticated;
grant execute on function join_session(text, text, text) to anon, authenticated;
grant execute on function player_poll(uuid) to anon, authenticated;
grant execute on function create_claim(uuid, int, text) to anon, authenticated;
grant execute on function respond_claim(uuid, uuid, boolean) to anon, authenticated;
grant execute on function cancel_claim(uuid, uuid) to anon, authenticated;
grant execute on function submit_board(uuid) to anon, authenticated;
grant execute on function create_session(text, int, ranking_mode, boolean, int, int, text[])
  to authenticated;
grant execute on function start_session(uuid) to authenticated;
grant execute on function end_session(uuid) to authenticated;
grant execute on function session_leaderboard(uuid) to authenticated;
grant execute on function session_activity(uuid, int) to authenticated;
grant execute on function server_now() to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime (admin dashboard only); skipped where the publication doesn't exist.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table players;
    alter publication supabase_realtime add table claims;
    alter publication supabase_realtime add table sessions;
  end if;
end $$;
