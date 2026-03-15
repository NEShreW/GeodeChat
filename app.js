// ============================================================
// GeodeChat — app.js
// Main client-side logic for the Discord-like chat interface.
//
// Depends on:
//   • window.supabase  (Supabase JS v2, loaded via CDN in app.html)
//   • app.css          (styles)
//
// Architecture:
//   1. Config & client init
//   2. Application state
//   3. Utilities (toast, escapeHtml, formatting helpers)
//   4. Modal helpers
//   5. Profile management
//   6. Auth
//   7. Guilds
//   8. Channels
//   9. Messages + Realtime
//  10. Members
//  11. Invites
//  12. UI rendering
//  13. Event listeners
//  14. Bootstrap (init)
// ============================================================

// ─────────────────────────────────────────
// 1. CONFIG  ← replace these two values with your Supabase project
// ─────────────────────────────────────────
const SUPABASE_URL      = 'YOUR_SUPABASE_URL';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';

// One-time invite time-to-live (default: 1 hour)
const SHORT_INVITE_TTL_MS = 60 * 60 * 1000;

// Auto-scroll the chat when the user is within this many pixels of the bottom
const AUTO_SCROLL_THRESHOLD_PX = 120;

// Consecutive messages from the same user within this window are visually grouped
const MESSAGE_GROUP_THRESHOLD_MIN = 5;

// ─────────────────────────────────────────
// 2. SUPABASE CLIENT
// ─────────────────────────────────────────
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ─────────────────────────────────────────
// 3. APPLICATION STATE
// ─────────────────────────────────────────
const state = {
  user:         null,   // auth.users row for the signed-in user
  profile:      null,   // profiles row for the signed-in user
  guilds:       [],     // guilds the user belongs to
  activeGuild:  null,   // currently selected guild (with .role attached)
  channels:     [],     // channels in activeGuild
  activeChannel: null,  // currently selected channel
  messages:     [],     // messages loaded in activeChannel
  members:      [],     // guild_members rows for activeGuild
  profileCache: {},     // { userId: { id, username } } — avoid repeat fetches
  realtimeSub:  null,   // active Supabase Realtime channel subscription
};

// ─────────────────────────────────────────
// 4. UTILITIES
// ─────────────────────────────────────────

/** Show a toast notification.
 *  @param {string} message
 *  @param {'info'|'success'|'error'} type
 */
function toast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  // Auto-remove after 4 seconds
  setTimeout(() => el.remove(), 4000);
}

/** Escape HTML special characters to prevent XSS when rendering user content. */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Format a UTC timestamp as a human-readable time (or date + time for old messages). */
function formatTime(ts) {
  const d   = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `Today at ${time}`;
  const date = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${date} at ${time}`;
}

/** Return the first 1–2 initials from a display name (e.g. "John Doe" → "JD"). */
function getInitials(name) {
  if (!name) return '?';
  const words = name.trim().split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

/** Derive a consistent accent colour for a user from their ID. */
function userColor(userId) {
  const palette = ['#5865f2','#57f287','#faa81a','#eb459e','#ed4245','#1abc9c','#ff9c05'];
  let hash = 0;
  for (const ch of String(userId)) hash = (hash * 31 + ch.charCodeAt(0)) & 0x7fffffff;
  return palette[hash % palette.length];
}

/** Generate a 7-character short invite code (alphanumeric, no ambiguous chars). */
function generateShortCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: 7 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

/** Extract a bare invite code from either a full URL or a plain code string. */
function extractCode(input) {
  try {
    const url  = new URL(input.trim());
    const code = url.searchParams.get('code');
    if (code) return code.trim();
  } catch {
    // Not a URL — treat input as a plain code
  }
  return input.trim();
}

// ─────────────────────────────────────────
// 5. MODAL HELPERS
// ─────────────────────────────────────────

function showModal(id) { document.getElementById(id)?.classList.remove('hidden'); }
function hideModal(id) { document.getElementById(id)?.classList.add('hidden'); }

// Close any modal when its backdrop overlay is clicked
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-overlay')) {
    e.target.classList.add('hidden');
  }
});

// ─────────────────────────────────────────
// 6. PROFILE MANAGEMENT
// ─────────────────────────────────────────

/**
 * Ensure a profiles row exists for the current user.
 * For email sign-ups the username is stored in user_metadata.
 * For Google OAuth the full_name comes from user_metadata.
 */
async function ensureProfile(user) {
  const { data } = await sb
    .from('profiles')
    .select('id, username')
    .eq('id', user.id)
    .maybeSingle();

  if (data) {
    state.profile             = data;
    state.profileCache[user.id] = data;
    return data;
  }

  // Derive a username to use for the new profile
  const username =
    user.user_metadata?.username ||
    user.user_metadata?.full_name ||
    user.email?.split('@')[0] ||
    'User';

  const { data: created } = await sb
    .from('profiles')
    .insert({ id: user.id, username })
    .select()
    .maybeSingle();

  const profile = created ?? { id: user.id, username };
  state.profile             = profile;
  state.profileCache[user.id] = profile;
  return profile;
}

/**
 * Fetch profiles for an array of user IDs, storing results in profileCache.
 * Skips IDs that are already cached.
 */
async function fetchProfiles(userIds) {
  const missing = [...new Set(userIds)].filter((id) => id && !state.profileCache[id]);
  if (missing.length === 0) return;

  const { data } = await sb
    .from('profiles')
    .select('id, username')
    .in('id', missing);

  for (const p of data ?? []) {
    state.profileCache[p.id] = p;
  }
}

/** Get the cached display name for a userId, falling back gracefully. */
function getDisplayName(userId) {
  return state.profileCache[userId]?.username ?? 'Unknown';
}

// ─────────────────────────────────────────
// 7. AUTH
// ─────────────────────────────────────────

/** Initialise the app after confirming the user is authenticated. */
async function initAuth() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    // Not logged in — send to login page
    window.location.href = 'index.html';
    return;
  }
  state.user = session.user;
  await ensureProfile(session.user);
  renderUserArea();
  await loadGuilds();
}

/** Sign out and redirect to the login page. */
async function signOut() {
  await sb.auth.signOut();
  window.location.href = 'index.html';
}

// Listen for auth changes (token refresh, forced sign-out, OAuth callback)
sb.auth.onAuthStateChange(async (event, session) => {
  if (event === 'SIGNED_OUT') {
    window.location.href = 'index.html';
  } else if (event === 'SIGNED_IN' && session && !state.user) {
    // OAuth redirect back to app.html — bootstrap the app
    state.user = session.user;
    await ensureProfile(session.user);
    renderUserArea();
    await loadGuilds();
  }
});

// ─────────────────────────────────────────
// 8. GUILDS
// ─────────────────────────────────────────

/** Fetch all guilds the current user is a member of, then render. */
async function loadGuilds() {
  const { data, error } = await sb
    .from('guild_members')
    .select('guild_id, role, guilds(id, name, owner_id)')
    .eq('user_id', state.user.id);

  if (error) {
    toast('Failed to load servers: ' + error.message, 'error');
    return;
  }

  state.guilds = (data ?? []).map((row) => ({
    ...row.guilds,
    role: row.role,
  }));

  renderGuildBar();

  if (state.guilds.length > 0) {
    // Keep the currently selected guild selected (e.g. after creating a new one)
    const keepId = state.activeGuild?.id;
    const target = state.guilds.find((g) => g.id === keepId) ?? state.guilds[0];
    await selectGuild(target.id);
  } else {
    // No guilds — show a welcome prompt
    state.activeGuild  = null;
    state.activeChannel = null;
    renderGuildHeader();
    document.getElementById('channel-list').innerHTML = '';
    document.getElementById('member-list').innerHTML  = '';
    renderEmptyState();
  }
}

/** Select a guild: update sidebar, channels, and members. */
async function selectGuild(guildId) {
  unsubscribeFromChannel();
  state.activeGuild   = state.guilds.find((g) => g.id === guildId) ?? null;
  state.activeChannel = null;
  state.messages      = [];

  if (!state.activeGuild) return;

  // Highlight the chosen guild in the bar
  document.querySelectorAll('.guild-icon').forEach((el) => {
    el.classList.toggle('active', el.dataset.guildId === guildId);
  });

  renderGuildHeader();
  await Promise.all([loadChannels(guildId), loadMembers(guildId)]);

  if (state.channels.length > 0) {
    await selectChannel(state.channels[0].id);
  } else {
    renderEmptyChat();
  }
}

/**
 * Create a new guild via the `create_guild` RPC (atomic: guild + owner membership
 * + default #general channel in one transaction).
 */
async function createGuild(name) {
  const { data, error } = await sb.rpc('create_guild', { guild_name: name.trim() });
  if (error || data?.error) {
    toast(data?.error ?? error.message, 'error');
    return false;
  }
  toast(`Server "${name}" created!`, 'success');
  // Refresh guilds list and navigate to the new guild
  const newId = data.guild_id;
  await loadGuilds();
  const found = state.guilds.find((g) => g.id === newId);
  if (found) await selectGuild(newId);
  return true;
}

/** Leave a guild (non-owner members only). */
async function leaveGuild(guildId) {
  if (state.activeGuild?.role === 'owner') {
    toast('Owners cannot leave a server. Delete it instead.', 'error');
    return;
  }
  const { error } = await sb
    .from('guild_members')
    .delete()
    .eq('guild_id', guildId)
    .eq('user_id', state.user.id);
  if (error) { toast('Failed to leave server: ' + error.message, 'error'); return; }
  toast('Left the server.', 'success');
  state.activeGuild = null;
  await loadGuilds();
}

/** Delete a guild entirely (owner only). */
async function deleteGuild(guildId) {
  const { error } = await sb.from('guilds').delete().eq('id', guildId);
  if (error) { toast('Failed to delete server: ' + error.message, 'error'); return; }
  toast('Server deleted.', 'success');
  state.activeGuild = null;
  await loadGuilds();
}

// ─────────────────────────────────────────
// 9. CHANNELS
// ─────────────────────────────────────────

/** Load all channels for a guild, ordered by creation time. */
async function loadChannels(guildId) {
  const { data, error } = await sb
    .from('channels')
    .select('id, name, created_at')
    .eq('guild_id', guildId)
    .order('created_at', { ascending: true });

  if (error) { toast('Failed to load channels: ' + error.message, 'error'); return; }
  state.channels = data ?? [];
  renderChannelList();
}

/** Select a channel: load its messages and subscribe to realtime updates. */
async function selectChannel(channelId) {
  unsubscribeFromChannel();
  state.activeChannel = state.channels.find((c) => c.id === channelId) ?? null;
  state.messages = [];

  if (!state.activeChannel) return;

  // Update active highlight in channel list
  document.querySelectorAll('.channel-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.channelId === channelId);
  });

  // Update input placeholder and show the input bar
  const input = document.getElementById('message-input');
  if (input) input.placeholder = `Message #${state.activeChannel.name}`;
  document.getElementById('message-input-area')?.classList.remove('hidden');

  renderChatHeader();
  await loadMessages(channelId);
  subscribeToChannel(channelId);
}

/** Create a text channel in the active guild (owner / admin only). */
async function createChannel(name) {
  if (!state.activeGuild) return false;
  const { data, error } = await sb
    .from('channels')
    .insert({ guild_id: state.activeGuild.id, name: name.trim() })
    .select()
    .single();
  if (error) { toast('Failed to create channel: ' + error.message, 'error'); return false; }
  toast(`Channel #${name} created!`, 'success');
  await loadChannels(state.activeGuild.id);
  if (data) await selectChannel(data.id);
  return true;
}

// ─────────────────────────────────────────
// 10. MESSAGES + REALTIME
// ─────────────────────────────────────────

/** Load the most recent 50 messages in a channel. */
async function loadMessages(channelId) {
  const { data, error } = await sb
    .from('messages')
    .select('id, user_id, content, created_at')
    .eq('channel_id', channelId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) { toast('Failed to load messages: ' + error.message, 'error'); return; }

  // Reverse so oldest is displayed at the top
  state.messages = (data ?? []).reverse();

  // Pre-fetch display names for all authors
  await fetchProfiles(state.messages.map((m) => m.user_id));
  renderMessages();
}

/** Insert a new message row. The realtime subscription will display it. */
async function sendMessage(content) {
  if (!state.activeChannel || !content.trim()) return;
  const { error } = await sb.from('messages').insert({
    channel_id: state.activeChannel.id,
    user_id:    state.user.id,
    content:    content.trim(),
  });
  if (error) toast('Failed to send message: ' + error.message, 'error');
}

/** Subscribe to INSERT events on the messages table for the given channel. */
function subscribeToChannel(channelId) {
  state.realtimeSub = sb
    .channel(`messages:${channelId}`)
    .on(
      'postgres_changes',
      {
        event:  'INSERT',
        schema: 'public',
        table:  'messages',
        filter: `channel_id=eq.${channelId}`,
      },
      async (payload) => {
        const msg = payload.new;
        await fetchProfiles([msg.user_id]);

        const prevMsg = state.messages[state.messages.length - 1] ?? null;
        state.messages.push(msg);
        appendMessage(msg, prevMsg);

        // Auto-scroll only when the user is near the bottom (within 120 px)
        const container = document.getElementById('messages-container');
        if (container) {
          const nearBottom =
            container.scrollHeight - container.scrollTop - container.clientHeight < AUTO_SCROLL_THRESHOLD_PX;
          if (nearBottom) container.scrollTop = container.scrollHeight;
        }
      }
    )
    .subscribe();
}

/** Remove the active Supabase Realtime channel subscription. */
function unsubscribeFromChannel() {
  if (state.realtimeSub) {
    sb.removeChannel(state.realtimeSub);
    state.realtimeSub = null;
  }
}

// ─────────────────────────────────────────
// 11. MEMBERS
// ─────────────────────────────────────────

/** Load guild members and their profiles, then render the member list. */
async function loadMembers(guildId) {
  const { data, error } = await sb
    .from('guild_members')
    .select('user_id, role, joined_at')
    .eq('guild_id', guildId);

  if (error) { toast('Failed to load members: ' + error.message, 'error'); return; }
  state.members = data ?? [];
  await fetchProfiles(state.members.map((m) => m.user_id));
  renderMemberList();
}

// ─────────────────────────────────────────
// 12. INVITES
// ─────────────────────────────────────────

/** Create a public (UUID-code, unlimited uses, no expiry) invite. */
async function createPublicInvite() {
  if (!state.activeGuild) return null;
  const code = crypto.randomUUID();
  const { error } = await sb.from('invites').insert({
    code,
    guild_id:   state.activeGuild.id,
    created_by: state.user.id,
    type:       'public',
    max_uses:   null,   // unlimited
    expires_at: null,   // never
  });
  if (error) { toast('Failed to create invite: ' + error.message, 'error'); return null; }
  return code;
}

/** Create a one-time (short code, max_uses=1, expires in 1 hour) invite. */
async function createShortInvite() {
  if (!state.activeGuild) return null;
  const code      = generateShortCode();
  const expiresAt = new Date(Date.now() + SHORT_INVITE_TTL_MS).toISOString();
  const { error } = await sb.from('invites').insert({
    code,
    guild_id:   state.activeGuild.id,
    created_by: state.user.id,
    type:       'short',
    max_uses:   1,
    expires_at: expiresAt,
  });
  if (error) { toast('Failed to create invite: ' + error.message, 'error'); return null; }
  return code;
}

/** Fetch all invites for the active guild. */
async function loadInvites() {
  if (!state.activeGuild) return [];
  const { data, error } = await sb
    .from('invites')
    .select('code, type, uses, max_uses, expires_at, created_at')
    .eq('guild_id', state.activeGuild.id)
    .order('created_at', { ascending: false });
  if (error) { toast('Failed to load invites: ' + error.message, 'error'); return []; }
  return data ?? [];
}

/**
 * Redeem an invite code via the `redeem_invite` Postgres function.
 * Accepts a full URL (invite.html?code=...) or a bare code.
 */
async function redeemInviteByCode(input) {
  const code = extractCode(input);
  const { data, error } = await sb.rpc('redeem_invite', { invite_code: code });
  if (error) return { error: error.message };
  return data; // { success, guild_id } or { error, guild_id? }
}

/** Delete an invite (owner / admin only). */
async function deleteInvite(code) {
  const { error } = await sb.from('invites').delete().eq('code', code);
  if (error) { toast('Failed to delete invite: ' + error.message, 'error'); return false; }
  return true;
}

// ─────────────────────────────────────────
// 13. UI RENDERING
// ─────────────────────────────────────────

/** Render the guild icons in the left guild bar. */
function renderGuildBar() {
  const list = document.getElementById('guild-list');
  if (!list) return;
  list.innerHTML = '';
  for (const guild of state.guilds) {
    const el = document.createElement('div');
    el.className       = 'guild-icon' + (state.activeGuild?.id === guild.id ? ' active' : '');
    el.dataset.guildId = guild.id;
    el.title           = guild.name;
    el.textContent     = getInitials(guild.name);
    el.style.background = userColor(guild.id);
    el.addEventListener('click', () => selectGuild(guild.id));
    list.appendChild(el);
  }
}

/** Render the guild name header and show/hide privileged dropdown items. */
function renderGuildHeader() {
  const nameEl = document.getElementById('guild-header-name');
  if (nameEl) nameEl.textContent = state.activeGuild?.name ?? 'GeodeChat';

  const role         = state.activeGuild?.role;
  const isPrivileged = role === 'owner' || role === 'admin';
  const isOwner      = role === 'owner';

  document.getElementById('btn-invite')?.classList.toggle('hidden', !isPrivileged);
  document.getElementById('btn-create-channel')?.classList.toggle('hidden', !isPrivileged);
  document.getElementById('btn-delete-guild')?.classList.toggle('hidden', !isOwner);
  // Leave is hidden from owners (they must delete instead)
  document.getElementById('btn-leave-guild')?.classList.toggle('hidden', isOwner || !state.activeGuild);
}

/** Render the channel list in the sidebar. */
function renderChannelList() {
  const list = document.getElementById('channel-list');
  if (!list) return;
  list.innerHTML = '';

  if (state.channels.length === 0) {
    list.innerHTML = '<div class="text-muted" style="padding:12px 8px;font-size:13px;">No channels yet</div>';
    return;
  }

  // Section label
  const label = document.createElement('div');
  label.className   = 'channel-section-label';
  label.textContent = 'Text Channels';
  list.appendChild(label);

  for (const ch of state.channels) {
    const el = document.createElement('div');
    el.className        = 'channel-item' + (state.activeChannel?.id === ch.id ? ' active' : '');
    el.dataset.channelId = ch.id;
    el.innerHTML        = `<span class="channel-prefix">#</span>${escapeHtml(ch.name)}`;
    el.addEventListener('click', () => selectChannel(ch.id));
    list.appendChild(el);
  }
}

/** Render the current-user area at the bottom of the channel sidebar. */
function renderUserArea() {
  const nameEl   = document.getElementById('current-username');
  const avatarEl = document.getElementById('user-avatar');
  const name     = state.profile?.username ?? state.user?.email ?? 'User';

  if (nameEl)   nameEl.textContent   = name;
  if (avatarEl) {
    avatarEl.textContent    = getInitials(name);
    avatarEl.style.background = userColor(state.user?.id ?? '0');
  }
}

/** Render the chat area header (channel name). */
function renderChatHeader() {
  const el = document.getElementById('chat-channel-name');
  if (el) el.textContent = state.activeChannel?.name ?? '';
}

/** Render all loaded messages from scratch. */
function renderMessages() {
  const container = document.getElementById('messages-container');
  if (!container) return;
  container.innerHTML = '';

  if (state.messages.length === 0) {
    container.innerHTML =
      '<div class="chat-welcome"><div style="font-size:36px;margin-bottom:12px;">📜</div>' +
      '<p>No messages yet — send the first one!</p></div>';
    return;
  }

  for (let i = 0; i < state.messages.length; i++) {
    appendMessage(state.messages[i], state.messages[i - 1] ?? null, false);
  }
  // Scroll to the bottom after initial render
  container.scrollTop = container.scrollHeight;
}

/**
 * Append a single message element to the messages container.
 * Groups consecutive messages from the same user (< 5 min apart) to reduce noise.
 *
 * @param {object}       msg          - Message row from Supabase
 * @param {object|null}  prevMsg      - Previous message (null for first)
 * @param {boolean}      scrollToBottom - Scroll after inserting (default: true)
 */
function appendMessage(msg, prevMsg = null, scrollToBottom = true) {
  const container = document.getElementById('messages-container');
  if (!container) return;

  // Remove the empty-state placeholder if present
  const welcome = container.querySelector('.chat-welcome');
  if (welcome) welcome.remove();

  // Determine grouping: same author AND within 5 minutes of previous message
  const isSameAuthor = prevMsg?.user_id === msg.user_id;
  const timeDiff     = prevMsg
    ? (new Date(msg.created_at) - new Date(prevMsg.created_at)) / 60_000
    : Infinity;
  const grouped = isSameAuthor && timeDiff < MESSAGE_GROUP_THRESHOLD_MIN;

  const author = getDisplayName(msg.user_id);
  const color  = userColor(msg.user_id);

  const el = document.createElement('div');
  el.className       = `message ${grouped ? 'message-grouped' : 'message-full'}`;
  el.dataset.messageId = msg.id;

  if (grouped) {
    // Abbreviated row — no avatar or username header
    el.innerHTML = `
      <div class="message-avatar-placeholder"></div>
      <div class="message-body">
        <div class="message-text">${escapeHtml(msg.content)}</div>
      </div>
    `;
  } else {
    // Full row — avatar, username, timestamp, content
    el.innerHTML = `
      <div class="message-avatar" style="background:${color}" title="${escapeHtml(author)}">
        ${escapeHtml(getInitials(author))}
      </div>
      <div class="message-body">
        <div class="message-header">
          <span class="message-author" style="color:${color}">${escapeHtml(author)}</span>
          <span class="message-timestamp">${formatTime(msg.created_at)}</span>
        </div>
        <div class="message-text">${escapeHtml(msg.content)}</div>
      </div>
    `;
  }

  container.appendChild(el);
  if (scrollToBottom) container.scrollTop = container.scrollHeight;
}

/** Render the members grouped by role (Owner → Admin → Member). */
function renderMemberList() {
  const list = document.getElementById('member-list');
  if (!list) return;
  list.innerHTML = '';

  const byRole = { owner: [], admin: [], member: [] };
  for (const m of state.members) {
    (byRole[m.role] ?? byRole.member).push(m);
  }

  const sections = [
    { label: 'Owner',   items: byRole.owner  },
    { label: 'Admins',  items: byRole.admin  },
    { label: 'Members', items: byRole.member },
  ];

  for (const { label, items } of sections) {
    if (items.length === 0) continue;

    const sectionLabel = document.createElement('div');
    sectionLabel.className   = 'member-section-label';
    sectionLabel.textContent = `${label} — ${items.length}`;
    list.appendChild(sectionLabel);

    for (const m of items) {
      const name = getDisplayName(m.user_id);
      const el   = document.createElement('div');
      el.className = 'member-item';
      el.innerHTML = `
        <div class="member-avatar" style="background:${userColor(m.user_id)}">
          ${escapeHtml(getInitials(name))}
        </div>
        <div class="member-name">${escapeHtml(name)}</div>
      `;
      list.appendChild(el);
    }
  }
}

/** Show the welcome / no-guild empty state in the chat area. */
function renderEmptyState() {
  const container = document.getElementById('messages-container');
  if (container) {
    container.innerHTML = `
      <div class="chat-welcome">
        <div style="font-size:52px;margin-bottom:16px;">💬</div>
        <h2>Welcome to GeodeChat!</h2>
        <p>Create or join a server to get started.</p>
      </div>
    `;
  }
  const nameEl = document.getElementById('chat-channel-name');
  if (nameEl) nameEl.textContent = '';
  document.getElementById('message-input-area')?.classList.add('hidden');
}

/** Show the "no channels" empty state for a guild that has no channels yet. */
function renderEmptyChat() {
  const container = document.getElementById('messages-container');
  if (container) {
    container.innerHTML = `
      <div class="chat-welcome">
        <div style="font-size:52px;margin-bottom:16px;">📢</div>
        <h2>${escapeHtml(state.activeGuild?.name ?? 'Server')}</h2>
        <p>No channels yet. Create one to start chatting!</p>
      </div>
    `;
  }
  document.getElementById('message-input-area')?.classList.add('hidden');
}

// ─────────────────────────────────────────
// 14. INVITE MODAL
// ─────────────────────────────────────────

/** Open the invite modal and populate the invite list. */
async function openInviteModal() {
  showModal('modal-invites');
  await refreshInviteList();
}

/** Fetch invites and rebuild the invite list inside the modal. */
async function refreshInviteList() {
  const container = document.getElementById('invite-list-container');
  if (!container) return;
  container.innerHTML = '<div class="loading">Loading…</div>';

  const invites = await loadInvites();
  container.innerHTML = '';

  if (invites.length === 0) {
    container.innerHTML =
      '<div class="text-muted" style="font-size:13px;">No active invites. Create one above.</div>';
    return;
  }

  // Build the base URL used for public invite links
  const basePath = window.location.pathname.replace(/\/[^/]*$/, '');
  const baseUrl  = `${window.location.origin}${basePath}/invite.html`;

  for (const inv of invites) {
    const isPublic      = inv.type === 'public';
    const displayValue  = isPublic ? `${baseUrl}?code=${inv.code}` : inv.code;
    const usesText      = inv.max_uses != null
      ? `${inv.uses}/${inv.max_uses} use${inv.max_uses !== 1 ? 's' : ''}`
      : `${inv.uses} use${inv.uses !== 1 ? 's' : ''}`;
    const expiryText    = inv.expires_at
      ? `Expires ${new Date(inv.expires_at).toLocaleString()}`
      : 'No expiry';

    const wrapper = document.createElement('div');
    wrapper.style.marginBottom = '12px';
    wrapper.innerHTML = `
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;
                  color:var(--text-secondary);margin-bottom:4px;">
        ${isPublic ? '🔗 Public Link' : '🔑 One-Time Code'} — ${usesText} — ${expiryText}
      </div>
      <div class="invite-link-box">
        <span class="invite-link-code" title="${escapeHtml(displayValue)}">
          ${escapeHtml(displayValue)}
        </span>
        <button class="invite-action-btn"
                data-copy="${escapeHtml(displayValue)}">Copy</button>
        <button class="invite-action-btn danger"
                data-delete="${escapeHtml(inv.code)}" title="Delete invite">✕</button>
      </div>
    `;
    container.appendChild(wrapper);
  }

  // Bind copy buttons
  container.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.copy)
        .then(() => toast('Copied to clipboard!', 'success'))
        .catch(() => toast('Could not copy — please copy manually.', 'error'));
    });
  });

  // Bind delete buttons
  container.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = await deleteInvite(btn.dataset.delete);
      if (ok) {
        toast('Invite deleted.', 'success');
        await refreshInviteList();
      }
    });
  });
}

// ─────────────────────────────────────────
// 15. EVENT LISTENERS
// ─────────────────────────────────────────

function initEventListeners() {
  // ── Sign out ──
  document.getElementById('btn-signout')?.addEventListener('click', signOut);

  // ── Add server (opens guild-options modal) ──
  document.getElementById('btn-add-guild')?.addEventListener('click', () => {
    showModal('modal-guild-options');
  });

  // ── Guild options → create ──
  document.getElementById('btn-show-create-guild')?.addEventListener('click', () => {
    hideModal('modal-guild-options');
    showModal('modal-create-guild');
  });

  // ── Guild options → join ──
  document.getElementById('btn-show-join-guild')?.addEventListener('click', () => {
    hideModal('modal-guild-options');
    showModal('modal-join-guild');
  });

  // ── Create guild form ──
  document.getElementById('form-create-guild')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('input-guild-name');
    const name  = input.value.trim();
    if (!name) return;
    const btn     = e.target.querySelector('button[type="submit"]');
    btn.disabled  = true;
    const ok = await createGuild(name);
    btn.disabled  = false;
    if (ok) { input.value = ''; hideModal('modal-create-guild'); }
  });

  // ── Join guild form ──
  document.getElementById('form-join-guild')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input    = document.getElementById('input-invite-code');
    const errEl    = document.getElementById('join-error');
    const codeRaw  = input.value.trim();
    if (!codeRaw) return;

    errEl?.classList.add('hidden');
    const btn    = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;

    const result = await redeemInviteByCode(codeRaw);
    btn.disabled = false;

    if (result?.error && result.error !== 'Already a member') {
      if (errEl) { errEl.textContent = result.error; errEl.classList.remove('hidden'); }
      return;
    }

    input.value = '';
    hideModal('modal-join-guild');

    if (result?.error === 'Already a member') {
      toast('You are already in this server.', 'info');
    } else {
      toast('Joined server!', 'success');
    }

    // Navigate to the (new or existing) guild
    if (result?.guild_id) {
      await loadGuilds();
      await selectGuild(result.guild_id);
    }
  });

  // ── Guild header dropdown toggle ──
  document.getElementById('guild-header')?.addEventListener('click', (e) => {
    // Don't fire when clicking a dropdown item inside the header
    if (e.target.closest('.dropdown-item')) return;
    if (!state.activeGuild) return;
    const dd = document.getElementById('guild-dropdown');
    dd?.classList.toggle('hidden');
    document.getElementById('guild-header')
      ?.setAttribute('aria-expanded', dd?.classList.contains('hidden') ? 'false' : 'true');
  });

  // Close dropdown when clicking outside the guild header
  document.addEventListener('click', (e) => {
    const dd     = document.getElementById('guild-dropdown');
    const header = document.getElementById('guild-header');
    if (dd && !dd.classList.contains('hidden') && !header?.contains(e.target)) {
      dd.classList.add('hidden');
      header?.setAttribute('aria-expanded', 'false');
    }
  });

  // ── Leave guild ──
  document.getElementById('btn-leave-guild')?.addEventListener('click', async () => {
    document.getElementById('guild-dropdown')?.classList.add('hidden');
    if (!state.activeGuild) return;
    if (confirm(`Leave "${state.activeGuild.name}"?`)) await leaveGuild(state.activeGuild.id);
  });

  // ── Delete guild ──
  document.getElementById('btn-delete-guild')?.addEventListener('click', async () => {
    document.getElementById('guild-dropdown')?.classList.add('hidden');
    if (!state.activeGuild) return;
    if (confirm(`Permanently delete "${state.activeGuild.name}"? This cannot be undone.`)) {
      await deleteGuild(state.activeGuild.id);
    }
  });

  // ── Invite people ──
  document.getElementById('btn-invite')?.addEventListener('click', () => {
    document.getElementById('guild-dropdown')?.classList.add('hidden');
    openInviteModal();
  });

  // ── Create channel ──
  document.getElementById('btn-create-channel')?.addEventListener('click', () => {
    document.getElementById('guild-dropdown')?.classList.add('hidden');
    showModal('modal-create-channel');
  });

  // ── Create channel form ──
  document.getElementById('form-create-channel')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('input-channel-name');
    const name  = input.value.trim().toLowerCase().replace(/\s+/g, '-');
    if (!name) return;
    const btn    = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    const ok = await createChannel(name);
    btn.disabled = false;
    if (ok) { input.value = ''; hideModal('modal-create-channel'); }
  });

  // ── Message input: send on Enter (Shift+Enter inserts newline — but input not textarea) ──
  document.getElementById('message-input')?.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const input   = e.target;
      const content = input.value;
      input.value   = '';
      await sendMessage(content);
    }
  });

  // ── Message send button ──
  document.getElementById('btn-send-message')?.addEventListener('click', async () => {
    const input   = document.getElementById('message-input');
    const content = input.value;
    input.value   = '';
    await sendMessage(content);
  });

  // ── Create public invite ──
  document.getElementById('btn-create-public-invite')?.addEventListener('click', async () => {
    const code = await createPublicInvite();
    if (code) { toast('Public invite link created!', 'success'); await refreshInviteList(); }
  });

  // ── Create short (one-time) invite ──
  document.getElementById('btn-create-short-invite')?.addEventListener('click', async () => {
    const code = await createShortInvite();
    if (code) { toast('One-time code created!', 'success'); await refreshInviteList(); }
  });

  // ── Universal "data-close-modal" close buttons ──
  document.querySelectorAll('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', () => hideModal(btn.dataset.closeModal));
  });
}

// ─────────────────────────────────────────
// 16. BOOTSTRAP
// ─────────────────────────────────────────

async function init() {
  initEventListeners();
  await initAuth();
}

init();
