# GeodeChat 💬

A public, Discord-like group chat web app built with **vanilla HTML / CSS / JS** and **Supabase** (Auth + Postgres + Realtime). Designed for static hosting (GitHub Pages, Netlify, Vercel, etc.).

---

## Features

| Feature | Details |
|---|---|
| **Auth** | Email + password sign-up / log-in, Google OAuth |
| **Servers (guilds)** | Create, join, leave, delete |
| **Channels** | Text channels per server, create by owner/admin |
| **Realtime chat** | Messages stream live via Supabase Realtime |
| **Invite links** | Public UUID links (no expiry) and one-time short codes (1-hour TTL) |
| **Roles** | `owner`, `admin`, `member` with RLS enforcement |
| **Security** | Row Level Security + `SECURITY DEFINER` Postgres functions — no data leakage |

---

## Project structure

```
GeodeChat/
├── supabase.sql   ← Run once in Supabase SQL editor (schema + RLS + functions)
├── index.html     ← Login / Sign-up page
├── app.html       ← Main chat UI
├── app.js         ← All client-side application logic
├── app.css        ← Discord-inspired dark theme
└── invite.html    ← Invite-link redemption page (?code=…)
```

---

## Quick-start

### 1 — Create a Supabase project

Go to [supabase.com](https://supabase.com), create a free project, and note your:
- **Project URL** — looks like `https://xyzxyzxyz.supabase.co`
- **Anon (public) key** — found in *Project Settings → API*

### 2 — Run the SQL script

Open **Database → SQL Editor** in the Supabase dashboard, paste the entire contents of `supabase.sql`, and click **Run**. This creates all tables, indexes, RLS policies, and Postgres functions.

### 3 — Enable Google OAuth (optional)

In the Supabase dashboard go to **Authentication → Providers → Google** and follow the instructions to add your Google OAuth client ID & secret.

Set the **redirect URL** in your Google OAuth consent screen to:

```
https://your-project.supabase.co/auth/v1/callback
```

### 4 — Add your Supabase keys to the frontend files

Replace the two placeholder strings in **each** of the three HTML/JS files:

| File | Lines to update |
|---|---|
| `index.html` | `SUPABASE_URL` and `SUPABASE_ANON_KEY` inside the `<script>` block |
| `app.js` | `SUPABASE_URL` and `SUPABASE_ANON_KEY` at the top |
| `invite.html` | `SUPABASE_URL` and `SUPABASE_ANON_KEY` inside the `<script>` block |

```js
// Change these two lines in each file:
const SUPABASE_URL      = 'https://xyzxyzxyz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...';
```

> **Tip:** The anon key is safe to expose in browser JS — Supabase Row Level Security enforces all access rules server-side.

### 5 — Deploy

Drop all files onto any static host:

```bash
# GitHub Pages — just push to main, then enable Pages in repo settings
# Netlify / Vercel — drag the folder into the dashboard
```

---

## How invites work

| Type | Code format | Default expiry | Max uses |
|---|---|---|---|
| **Public link** | UUID (`xxxxxxxx-xxxx-…`) | Never | Unlimited |
| **One-time code** | 7-char alphanumeric (`AbC1234`) | 1 hour | 1 |

- Share a **public link** as `https://yoursite.com/invite.html?code=<uuid>` — anyone with the link can join.
- Share a **one-time code** directly (`AbC1234`) — paste it in the *Join a Server* modal or visit `invite.html?code=AbC1234`.
- The `redeem_invite()` Postgres function validates expiry and use limits atomically (uses `SELECT … FOR UPDATE`) to prevent race conditions.

---

## Security model

All data access is enforced by **Supabase Row Level Security (RLS)**:

- Users can only read guilds, channels, and messages for guilds they are a member of.
- Only `owner` or `admin` roles can create channels or invites.
- Only the guild `owner` can delete the guild.
- Invite redemption, guild creation, and invite validation are handled by `SECURITY DEFINER` Postgres functions so they can perform privileged operations safely.
- The anon key cannot bypass RLS — the only way to read data is to be an authenticated member.

---

## Realtime

`app.js` uses Supabase Realtime `postgres_changes` to subscribe to `INSERT` events on the `messages` table filtered by `channel_id`. New messages appear instantly for all connected members without polling.

---

## Customisation

- **Colours:** edit the CSS custom properties at the top of `app.css`.
- **Message history depth:** change `.limit(50)` in `loadMessages()` in `app.js`.
- **Short invite duration:** change `60 * 60 * 1000` (milliseconds) in `createShortInvite()`.
- **Adding file uploads:** store files in Supabase Storage and save the URL in the message `content`.
