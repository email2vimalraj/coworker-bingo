-- Item 2: restrict joins to company email domains.
-- New error code: EMAIL_DOMAIN (join_session when the email's domain isn't allowed).

alter table sessions add column allowed_email_domains text[] not null default '{}';

-- Normalizes a domain list: lowercase, trimmed, deduped (first occurrence wins).
-- Raises INVALID_INPUT for anything that doesn't look like a domain (e.g. contains '@').
create function _normalize_domains(p_domains text[]) returns text[]
language plpgsql immutable set search_path = public as $$
declare
  v_out text[] := '{}';
  v_d text;
begin
  if p_domains is null then return '{}'; end if;
  foreach v_d in array p_domains loop
    v_d := lower(btrim(coalesce(v_d, '')));
    if v_d = '' then continue; end if;
    if char_length(v_d) > 253
       or v_d !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' then
      raise exception 'INVALID_INPUT' using detail = 'allowed_email_domains';
    end if;
    if not (v_d = any (v_out)) then
      v_out := v_out || v_d;
    end if;
  end loop;
  if coalesce(array_length(v_out, 1), 0) > 20 then
    raise exception 'INVALID_INPUT' using detail = 'allowed_email_domains';
  end if;
  return v_out;
end;
$$;
revoke execute on function _normalize_domains(text[]) from public, anon, authenticated;

-- join_session: same as 0001 plus the domain check.
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

  select * into v_session from sessions where code = upper(btrim(coalesce(p_code, '')));
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

-- Public info for the join page.
create function session_join_info(p_code text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_session sessions;
begin
  select * into v_session from sessions where code = upper(btrim(coalesce(p_code, '')));
  if not found then raise exception 'SESSION_NOT_FOUND'; end if;
  return jsonb_build_object(
    'name', v_session.name,
    'status', effective_status(v_session),
    'allowed_email_domains', to_jsonb(v_session.allowed_email_domains)
  );
end;
$$;
revoke execute on function session_join_info(text) from public, anon, authenticated;
grant execute on function session_join_info(text) to anon, authenticated;

-- create_session: new trailing param p_allowed_email_domains (default: any domain).
drop function create_session(text, int, ranking_mode, boolean, int, int, text[]);
create function create_session(
  p_name text,
  p_duration_seconds int,
  p_ranking_mode ranking_mode,
  p_require_full_card boolean,
  p_winners_count int,
  p_max_squares_per_coworker int,
  p_prompts text[],
  p_allowed_email_domains text[] default '{}'
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
     or coalesce(p_max_squares_per_coworker, 0) < 1 then
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
                        winners_count, max_squares_per_coworker, allowed_email_domains, created_by)
  values (v_code, btrim(p_name), p_duration_seconds, coalesce(p_ranking_mode, 'correct_then_time'),
          coalesce(p_require_full_card, false), p_winners_count, p_max_squares_per_coworker,
          v_domains, auth.uid())
  returning id into v_id;

  for i in 1..24 loop
    insert into session_prompts (session_id, text, position)
    values (v_id, btrim(p_prompts[i]), i - 1);
  end loop;

  return jsonb_build_object('id', v_id, 'code', v_code);
end;
$$;
revoke execute on function create_session(text, int, ranking_mode, boolean, int, int, text[], text[])
  from public, anon, authenticated;
grant execute on function create_session(text, int, ranking_mode, boolean, int, int, text[], text[])
  to authenticated;
