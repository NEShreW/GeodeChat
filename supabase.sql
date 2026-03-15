-- ============================================================
-- GeodeChat — Supabase SQL Setup Script
-- ============================================================
-- Run this entire script in the Supabase SQL editor
-- (Database → SQL Editor → New query → paste → Run).
-- ============================================================

-- ─────────────────────────────────────────
-- EXTENSIONS
-- ─────────────────────────────────────────
create extension if not exists "uuid-ossp";


-- ─────────────────────────────────────────
-- TABLES
-- ─────────────────────────────────────────

-- User display profiles (username for each auth user)
create table if not exists profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text not null check (char_length(username) between 1 and 64),
  created_at  timestamptz not null default now()
);

-- Servers / communities (called "guilds" after Discord internals)
create table if not exists guilds (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null check (char_length(name) between 1 and 64),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);

-- Membership — one row per (guild, user) pair
create table if not exists guild_members (
  guild_id   uuid not null references guilds(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'member'
               check (role in ('owner', 'admin', 'member')),
  joined_at  timestamptz not null default now(),
  primary key (guild_id, user_id)
);

-- Text channels inside a guild
create table if not exists channels (
  id          uuid primary key default uuid_generate_v4(),
  guild_id    uuid not null references guilds(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 64),
  created_at  timestamptz not null default now()
);

-- Chat messages
create table if not exists messages (
  id          uuid primary key default uuid_generate_v4(),
  channel_id  uuid not null references channels(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  content     text not null check (char_length(content) between 1 and 2000),
  created_at  timestamptz not null default now()
);

-- Invite codes
--   type = 'public'  → UUID code, unlimited uses (or capped), no default expiry
--   type = 'short'   → short alphanumeric code, max_uses=1, expires within 1 hour
create table if not exists invites (
  code        text primary key,
  guild_id    uuid not null references guilds(id) on delete cascade,
  created_by  uuid not null references auth.users(id) on delete cascade,
  type        text not null default 'public'
                check (type in ('public', 'short')),
  max_uses    integer,           -- null = unlimited
  uses        integer not null default 0,
  expires_at  timestamptz,       -- null = never expires
  created_at  timestamptz not null default now()
);


-- ─────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────
create index if not exists idx_guild_members_user   on guild_members(user_id);
create index if not exists idx_channels_guild       on channels(guild_id);
create index if not exists idx_messages_channel_ts  on messages(channel_id, created_at desc);
create index if not exists idx_invites_guild        on invites(guild_id);


-- ─────────────────────────────────────────
-- ROW LEVEL SECURITY — enable on every table
-- ─────────────────────────────────────────
alter table profiles      enable row level security;
alter table guilds        enable row level security;
alter table guild_members enable row level security;
alter table channels      enable row level security;
alter table messages      enable row level security;
alter table invites       enable row level security;


-- ─────────────────────────────────────────
-- HELPER FUNCTIONS (security definer, stable)
-- These run with the privileges of the function owner (postgres)
-- so they can bypass RLS when used inside policies.
-- ─────────────────────────────────────────

-- Returns true when `p_user` is a member of `p_guild`
create or replace function is_guild_member(p_guild uuid, p_user uuid)
returns boolean
language sql security definer stable as
$$
  select exists (
    select 1 from guild_members
    where guild_id = p_guild and user_id = p_user
  );
$$;

-- Returns the role of `p_user` in `p_guild` (null if not a member)
create or replace function guild_user_role(p_guild uuid, p_user uuid)
returns text
language sql security definer stable as
$$
  select role from guild_members
  where guild_id = p_guild and user_id = p_user
  limit 1;
$$;


-- ─────────────────────────────────────────
-- RLS POLICIES — profiles
-- ─────────────────────────────────────────

-- Any logged-in user can read all profiles (needed to show message authors)
create policy "profiles: authenticated users can read"
  on profiles for select
  using (auth.uid() is not null);

create policy "profiles: users insert own row"
  on profiles for insert
  with check (id = auth.uid());

create policy "profiles: users update own row"
  on profiles for update
  using (id = auth.uid());


-- ─────────────────────────────────────────
-- RLS POLICIES — guilds
-- ─────────────────────────────────────────

create policy "guilds: members can view"
  on guilds for select
  using (is_guild_member(id, auth.uid()));

create policy "guilds: authenticated users can create"
  on guilds for insert
  with check (auth.uid() is not null and owner_id = auth.uid());

create policy "guilds: owner can update"
  on guilds for update
  using (owner_id = auth.uid());

create policy "guilds: owner can delete"
  on guilds for delete
  using (owner_id = auth.uid());


-- ─────────────────────────────────────────
-- RLS POLICIES — guild_members
-- ─────────────────────────────────────────

create policy "guild_members: members can view their guild's roster"
  on guild_members for select
  using (is_guild_member(guild_id, auth.uid()));

-- Users can add themselves (via invite redemption or owner action)
create policy "guild_members: users can join (insert own row)"
  on guild_members for insert
  with check (user_id = auth.uid());

-- Members can remove themselves; owner/admin can remove anyone
create policy "guild_members: leave or kick"
  on guild_members for delete
  using (
    user_id = auth.uid()
    or guild_user_role(guild_id, auth.uid()) in ('owner', 'admin')
  );


-- ─────────────────────────────────────────
-- RLS POLICIES — channels
-- ─────────────────────────────────────────

create policy "channels: members can view"
  on channels for select
  using (is_guild_member(guild_id, auth.uid()));

create policy "channels: owner/admin can create"
  on channels for insert
  with check (guild_user_role(guild_id, auth.uid()) in ('owner', 'admin'));

create policy "channels: owner/admin can delete"
  on channels for delete
  using (guild_user_role(guild_id, auth.uid()) in ('owner', 'admin'));


-- ─────────────────────────────────────────
-- RLS POLICIES — messages
-- ─────────────────────────────────────────

-- A user can read messages in a channel only if they're a member of that channel's guild
create policy "messages: guild members can read"
  on messages for select
  using (
    exists (
      select 1 from channels c
      join guild_members gm on gm.guild_id = c.guild_id
      where c.id = channel_id
        and gm.user_id = auth.uid()
    )
  );

create policy "messages: guild members can send"
  on messages for insert
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from channels c
      join guild_members gm on gm.guild_id = c.guild_id
      where c.id = channel_id
        and gm.user_id = auth.uid()
    )
  );

create policy "messages: users can delete own messages"
  on messages for delete
  using (user_id = auth.uid());


-- ─────────────────────────────────────────
-- RLS POLICIES — invites
-- ─────────────────────────────────────────

create policy "invites: members can view"
  on invites for select
  using (is_guild_member(guild_id, auth.uid()));

create policy "invites: owner/admin can create"
  on invites for insert
  with check (
    created_by = auth.uid()
    and guild_user_role(guild_id, auth.uid()) in ('owner', 'admin')
  );

create policy "invites: owner/admin can delete"
  on invites for delete
  using (guild_user_role(guild_id, auth.uid()) in ('owner', 'admin'));


-- ─────────────────────────────────────────
-- POSTGRES FUNCTIONS
-- ─────────────────────────────────────────

-- ------------------------------------------------------------
-- create_guild(guild_name)
--   Atomically creates a guild, adds the creator as owner,
--   and creates a default #general channel.
--   Returns: { success: true, guild_id: uuid } or { error: text }
-- ------------------------------------------------------------
create or replace function create_guild(guild_name text)
returns json
language plpgsql security definer as
$$
declare
  new_guild_id uuid;
  uid          uuid := auth.uid();
begin
  if uid is null then
    return json_build_object('error', 'Not authenticated');
  end if;

  if char_length(trim(guild_name)) = 0 then
    return json_build_object('error', 'Server name cannot be empty');
  end if;

  -- Create the guild
  insert into guilds (name, owner_id)
  values (trim(guild_name), uid)
  returning id into new_guild_id;

  -- Add creator as owner
  insert into guild_members (guild_id, user_id, role)
  values (new_guild_id, uid, 'owner');

  -- Create default channel
  insert into channels (guild_id, name)
  values (new_guild_id, 'general');

  return json_build_object('success', true, 'guild_id', new_guild_id);
end;
$$;


-- ------------------------------------------------------------
-- get_invite_info(invite_code)
--   Returns basic info about an invite without requiring guild
--   membership (used by invite.html before the user has joined).
--   SECURITY DEFINER so it can read guilds/invites regardless of RLS.
--   Returns: { valid: true, guild_id, guild_name, type }
--         or { error: text }
-- ------------------------------------------------------------
create or replace function get_invite_info(invite_code text)
returns json
language plpgsql security definer as
$$
declare
  inv   invites%rowtype;
  gname text;
begin
  select * into inv from invites where code = invite_code;

  if not found then
    return json_build_object('error', 'Invalid invite code');
  end if;

  if inv.expires_at is not null and inv.expires_at < now() then
    return json_build_object('error', 'This invite has expired');
  end if;

  if inv.max_uses is not null and inv.uses >= inv.max_uses then
    return json_build_object('error', 'This invite has reached its maximum uses');
  end if;

  select name into gname from guilds where id = inv.guild_id;

  return json_build_object(
    'valid',      true,
    'guild_id',   inv.guild_id,
    'guild_name', gname,
    'type',       inv.type
  );
end;
$$;


-- ------------------------------------------------------------
-- redeem_invite(invite_code)
--   Validates an invite code and adds the calling user to the
--   guild. Uses SELECT … FOR UPDATE to prevent race conditions
--   when two users redeem the same limited-use code simultaneously.
--
--   Returns: { success: true, guild_id: uuid }
--         or { error: text, guild_id: uuid }  ← guild_id present on "already a member"
--         or { error: text }
-- ------------------------------------------------------------
create or replace function redeem_invite(invite_code text)
returns json
language plpgsql security definer as
$$
declare
  inv invites%rowtype;
  uid uuid := auth.uid();
begin
  if uid is null then
    return json_build_object('error', 'Not authenticated');
  end if;

  -- Lock the invite row to prevent duplicate redemption under load
  select * into inv
  from invites
  where code = invite_code
  for update;

  if not found then
    return json_build_object('error', 'Invalid invite code');
  end if;

  -- Check expiry
  if inv.expires_at is not null and inv.expires_at < now() then
    return json_build_object('error', 'This invite has expired');
  end if;

  -- Check use limit
  if inv.max_uses is not null and inv.uses >= inv.max_uses then
    return json_build_object('error', 'This invite has reached its maximum uses');
  end if;

  -- Already a member?
  if is_guild_member(inv.guild_id, uid) then
    return json_build_object('error', 'Already a member', 'guild_id', inv.guild_id);
  end if;

  -- Add user to guild
  insert into guild_members (guild_id, user_id, role)
  values (inv.guild_id, uid, 'member')
  on conflict do nothing;

  -- Increment use counter
  update invites set uses = uses + 1 where code = invite_code;

  -- For one-time (short) invites: mark as consumed by backdating expires_at to now().
  -- The uses >= max_uses check above already blocks re-use, but setting expires_at
  -- makes the "expired" state explicit and consistent in get_invite_info / UI display.
  if inv.type = 'short' then
    update invites set expires_at = now() where code = invite_code;
  end if;

  return json_build_object('success', true, 'guild_id', inv.guild_id);
end;
$$;
