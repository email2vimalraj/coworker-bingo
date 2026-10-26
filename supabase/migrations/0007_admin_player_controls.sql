-- Admin player controls: remove a player, list a player's confirmed squares, revoke a square.
-- A revoked claim is neither pending nor confirmed, so the unique index, the
-- coworker-limit counts and the leaderboard (confirmed only) all ignore it.
alter type claim_status add value if not exists 'revoked';

create function admin_remove_player(p_player_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_lost int;
  v_deleted int;
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;
  select count(*)::int into v_lost from claims
  where coworker_id = p_player_id and status = 'confirmed';
  delete from players where id = p_player_id;
  get diagnostics v_deleted = row_count;
  if v_deleted = 0 then raise exception 'PLAYER_NOT_FOUND'; end if;
  return jsonb_build_object('removed', true, 'squares_lost_by_others', v_lost);
end;
$$;

-- Preview for the remove-confirm step: other players' confirmed squares this person confirmed.
create function admin_player_impact(p_player_id uuid)
returns int
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;
  return (select count(*)::int from claims where coworker_id = p_player_id and status = 'confirmed');
end;
$$;

create function admin_player_squares(p_player_id uuid)
returns table (
  claim_id uuid,
  cell_index int,
  prompt text,
  coworker_name text,
  resolved_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;
  return query
    select c.id, c.cell_index, sp.text, cw.full_name, c.resolved_at
    from claims c
    join boards b on b.player_id = c.player_id and b.cell_index = c.cell_index
    left join session_prompts sp on sp.id = b.prompt_id
    join players cw on cw.id = c.coworker_id
    where c.player_id = p_player_id and c.status = 'confirmed'
    order by c.resolved_at, c.cell_index;
end;
$$;

create function admin_revoke_claim(p_claim_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_claim claims;
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;
  -- Lock the scanner's player row first (same order as the claim RPCs), then the claim.
  perform 1 from players where id = (select player_id from claims where id = p_claim_id) for update;
  select * into v_claim from claims where id = p_claim_id for update;
  if not found then raise exception 'CLAIM_NOT_FOUND'; end if;
  if v_claim.status <> 'confirmed' then raise exception 'CLAIM_NOT_PENDING'; end if;
  update claims set status = 'revoked', resolved_at = now() where id = p_claim_id;
  return jsonb_build_object('claim_id', p_claim_id, 'status', 'revoked');
end;
$$;

revoke execute on function admin_remove_player(uuid) from public, anon;
revoke execute on function admin_player_impact(uuid) from public, anon;
grant execute on function admin_player_impact(uuid) to authenticated;
revoke execute on function admin_player_squares(uuid) from public, anon;
revoke execute on function admin_revoke_claim(uuid) from public, anon;
grant execute on function admin_remove_player(uuid) to authenticated;
grant execute on function admin_player_squares(uuid) to authenticated;
grant execute on function admin_revoke_claim(uuid) to authenticated;
