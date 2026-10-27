-- Lets an existing admin create a confirmed email+password account and make it an admin, without
-- the service-role key. This is the only place the app writes to the auth schema.
-- New error codes: PASSWORD_REQUIRED, WEAK_PASSWORD (plus NOT_ADMIN, INVALID_INPUT).
create function admin_create(p_email text, p_password text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_id uuid;
  v_new int;
  v_created boolean := false;
begin
  if not is_admin() then raise exception 'NOT_ADMIN'; end if;
  if v_email = '' or char_length(v_email) > 254
     or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'INVALID_INPUT';
  end if;

  select id into v_id from auth.users where lower(email::text) = v_email limit 1;

  if v_id is null then
    if p_password is null or btrim(p_password) = '' then raise exception 'PASSWORD_REQUIRED'; end if;
    if char_length(p_password) < 8 or octet_length(p_password) > 72 then raise exception 'WEAK_PASSWORD'; end if;
    v_id := gen_random_uuid();
    begin
      insert into auth.users (
        instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
        confirmation_token, recovery_token, email_change_token_new, email_change,
        email_change_token_current, reauthentication_token, phone_change, phone_change_token
      ) values (
        '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
        extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
        '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(),
        '', '', '', '', '', '', '', ''
      );
      insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
      values (
        v_id::text, v_id,
        jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true),
        'email', now(), now(), now()
      );
      v_created := true;
    exception when unique_violation then
      -- Someone created the same email concurrently: fall back to the existing account.
      select id into v_id from auth.users where lower(email::text) = v_email limit 1;
      if v_id is null then raise; end if;
    end;
  end if;

  insert into admins (user_id) values (v_id) on conflict (user_id) do nothing;
  get diagnostics v_new = row_count;
  return jsonb_build_object('user_id', v_id, 'created', v_created, 'added', v_new > 0);
end;
$$;

revoke execute on function admin_create(text, text) from public, anon;
grant execute on function admin_create(text, text) to authenticated;
