-- Item 3: edit a session before it starts. Only while status = 'lobby' (else ALREADY_STARTED).
-- Prompts are updated in place by position so prompt ids (and boards of players who
-- already joined) stay valid.
create function update_session(
  p_session_id uuid,
  p_name text,
  p_duration_seconds int,
  p_ranking_mode ranking_mode,
  p_require_full_card boolean,
  p_winners_count int,
  p_max_squares_per_coworker int,
  p_allowed_email_domains text[],
  p_prompts text[]
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
     or coalesce(p_max_squares_per_coworker, 0) < 1 then
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
      allowed_email_domains = v_domains
  where id = p_session_id;

  for i in 1..24 loop
    update session_prompts set text = btrim(p_prompts[i])
    where session_id = p_session_id and position = i - 1;
  end loop;

  return jsonb_build_object('id', p_session_id, 'code', v_session.code);
end;
$$;
revoke execute on function update_session(uuid, text, int, ranking_mode, boolean, int, int, text[], text[])
  from public, anon, authenticated;
grant execute on function update_session(uuid, text, int, ranking_mode, boolean, int, int, text[], text[])
  to authenticated;
