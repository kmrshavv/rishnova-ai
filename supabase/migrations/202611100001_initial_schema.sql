create extension if not exists pgcrypto;

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text not null default '',
  avatar_url text not null default '',
  created_at timestamptz not null default now()
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  title text not null default 'New conversation' check (char_length(title) between 1 and 80),
  model text not null default 'qwen3.5:0.8b',
  pinned boolean not null default false,
  project text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) between 1 and 4000),
  created_at timestamptz not null default now(),
  foreign key (conversation_id, user_id)
    references public.conversations (id, user_id) on delete cascade
);

create index conversations_user_updated_idx
  on public.conversations (user_id, updated_at desc);
create index messages_conversation_created_idx
  on public.messages (conversation_id, created_at);
create index messages_user_created_idx
  on public.messages (user_id, created_at);

alter table public.profiles enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;

create policy "Users read their own profile"
  on public.profiles for select to authenticated
  using ((select auth.uid()) = id);
create policy "Users update their own profile"
  on public.profiles for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);
create policy "Users create their own profile"
  on public.profiles for insert to authenticated
  with check ((select auth.uid()) = id);

create policy "Users read their own conversations"
  on public.conversations for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Users create their own conversations"
  on public.conversations for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "Users update their own conversations"
  on public.conversations for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "Users delete their own conversations"
  on public.conversations for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users read their own messages"
  on public.messages for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Users create messages in their own conversations"
  on public.messages for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from public.conversations
      where conversations.id = messages.conversation_id
        and conversations.user_id = (select auth.uid())
    )
  );
create policy "Users delete their own messages"
  on public.messages for delete to authenticated
  using ((select auth.uid()) = user_id);

grant usage on schema public to authenticated;
revoke all on public.profiles, public.conversations, public.messages from anon;
revoke all on public.profiles, public.conversations, public.messages from authenticated;
grant select on public.profiles to authenticated;
grant insert (id, email, full_name, avatar_url) on public.profiles to authenticated;
grant update (full_name, avatar_url) on public.profiles to authenticated;
grant select, insert, update, delete on public.conversations to authenticated;
grant select, insert, delete on public.messages to authenticated;
