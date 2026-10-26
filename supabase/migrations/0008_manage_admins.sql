-- Manage admins from the app. New error codes: USER_NOT_FOUND, CANNOT_REMOVE_SELF, LAST_ADMIN.
alter table admins add column if not exists added_at timestamptz not null default now();

create function admin_list()
returns table (user_id uuid, email text, added_at timestamptz, is_me boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;
  return query
    select a.user_id, u.email::text, a.added_at, (a.user_id = auth.uid())
    from admins a
    left join auth.users u on u.id = a.user_id
    order by a.added_at, u.email;
end;
$$;

-- Adds an existing account (by email) as admin. No-op if already an admin.
create function admin_add(p_email text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_new int;
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;
  select id into v_id from auth.users
  where lower(email::text) = lower(btrim(coalesce(p_email, ''))) limit 1;
  if v_id is null then raise exception 'USER_NOT_FOUND'; end if;
  insert into admins (user_id) values (v_id) on conflict (user_id) do nothing;
  get diagnostics v_new = row_count;
  return jsonb_build_object('user_id', v_id, 'added', v_new > 0);
end;
$$;

create function admin_remove(p_user_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;
  if p_user_id = auth.uid() then raise exception 'CANNOT_REMOVE_SELF'; end if;
  -- Serialise concurrent removals so the last-admin check is reliable.
  lock table admins in share row exclusive mode;
  if (select count(*) from admins) <= 1 then raise exception 'LAST_ADMIN'; end if;
  delete from admins where user_id = p_user_id;
  return jsonb_build_object('removed', true);
end;
$$;

revoke execute on function admin_list() from public, anon;
revoke execute on function admin_add(text) from public, anon;
revoke execute on function admin_remove(uuid) from public, anon;
grant execute on function admin_list() to authenticated;
grant execute on function admin_add(text) to authenticated;
grant execute on function admin_remove(uuid) to authenticated;
