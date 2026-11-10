drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();

drop policy if exists "Users create their own profile" on public.profiles;
create policy "Users create their own profile"
  on public.profiles for insert to authenticated
  with check ((select auth.uid()) = id);

grant usage on schema public to authenticated;
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant insert (id, email, full_name, avatar_url) on public.profiles to authenticated;
grant update (full_name, avatar_url) on public.profiles to authenticated;
