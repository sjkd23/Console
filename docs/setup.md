# Setup Guide

Complete installation and configuration guide for guild administrators.

**Audience:** Guild administrators setting up the bot for the first time.

---

## Prerequisites

Before starting, ensure you have:

- **Discord Server** with Administrator permission
- **Discord Bot Token** from [Discord Developer Portal](https://discord.com/developers/applications)
- **Server Infrastructure:**
  - **Docker & Docker Compose** (recommended), OR
  - **Node.js 18+** and **PostgreSQL 14+** (manual setup)
- **Basic familiarity** with Discord server management

---

## 1. Discord Bot Setup

### Create Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application**
3. Name it (e.g., "RotMG Raid Bot")
4. Go to **Bot** section → **Add Bot**
5. Copy the **Bot Token** (you'll need this for `.env` files)

### Configure Intents

Under **Bot** → **Privileged Gateway Intents**, enable:
- ✅ **Server Members Intent**
- ✅ **Message Content Intent**

### Invite Bot to Server

1. Go to **OAuth2** → **URL Generator**
2. Select scopes:
   - ✅ `bot`
   - ✅ `applications.commands`
3. Select bot permissions:
   - ✅ **Administrator** (recommended for simplicity)
   - OR minimum: Manage Roles, Manage Channels, Send Messages, Embed Links, Attach Files, Manage Messages, Read Message History, Add Reactions, Use Slash Commands
4. Copy the generated URL and open it in your browser
5. Select your server and authorize

> **Important:** The bot's role in Discord must be positioned **above** any roles it needs to manage (e.g., verified_raider, suspended, muted).

---

## 2. Installation

### Option A: Docker (Recommended)

1. **Clone repository:**
   ```bash
   git clone <repository-url>
   cd rotmg-raid-bot
   ```

2. **Create environment files:**

   **backend/.env:**
   ```env
   PORT=4000
   BACKEND_API_KEY=your_random_secure_key_here
   DATABASE_URL=postgres://postgres:postgres@db:5432/rotmg_raids
   ```

   **bot/.env:**
   ```env
   APPLICATION_ID=your_discord_app_id
   SECRET_KEY=your_discord_bot_token
   DISCORD_DEV_GUILD_ID=your_server_id
   BACKEND_URL=http://backend:4000/v1
   BACKEND_API_KEY=your_random_secure_key_here
   ```

   > **Critical:** The `BACKEND_API_KEY` must match in both files.

3. **Start services:**
   ```bash
   docker-compose up -d
   ```

   This will:
   - Start PostgreSQL database
   - Run database migrations automatically
   - Start backend API on port 4000
   - Start Discord bot

4. **Verify running:**
   ```bash
   docker-compose logs -f
   ```
   Look for "Bot is ready!" and "Fastify listening on..."

### Option B: Manual Setup

1. **Install PostgreSQL 14+** and create database `rotmg_raids`

2. **Install dependencies:**
   ```bash
   cd backend
   npm install
   cd ../bot
   npm install
   ```

3. **Configure environment** (same as above, but use `localhost` instead of service names)

4. **Run migrations:**
   ```bash
   cd backend
   npm run migrate
   ```

5. **Start services** (in separate terminals):
   ```bash
   # Terminal 1 - Backend
   cd backend
   npm run dev

   # Terminal 2 - Bot
   cd bot
   npm run dev
   ```

---

## 3. Role Mapping

The bot uses **internal role names** that you must map to your Discord roles. This controls all command permissions.

### Internal Roles

| Internal Key | Purpose | Required? |
|--------------|---------|-----------|
| `administrator` | Full bot admin access | **Yes** |
| `moderator` | Moderation commands | Recommended |
| `head_organizer` | Senior raid staff | Optional |
| `officer` | Kick/ban/quota management | Recommended |
| `security` | Verification & discipline | **Yes** |
| `organizer` | Create and manage raids | **Yes** |
| `team` | Auto-assigned staff marker | Optional |
| `verified_raider` | Verified members | **Yes** |
| `suspended` | Temporary raid suspension | **Yes** |
| `muted` | Temporary message restriction | **Yes** |

### Configure with `/setroles`

Run this command to map internal roles to your Discord roles:

```
/setroles
  administrator: @Admin
  security: @Security
  organizer: @Organizer
  verified_raider: @Raider
  suspended: @Suspended
  muted: @Muted
```

**You can set multiple at once or update them individually.**

### Example Setup

For a typical guild structure:

```
/setroles
  administrator: @Officers
  moderator: @Moderators
  officer: @Officers
  security: @Security Team
  organizer: @Raid Leaders
  verified_raider: @Verified
  suspended: @Suspended
  muted: @Muted
```

> **Note:** You can run `/setroles` multiple times to update mappings. Only specify the roles you want to change.

### Permission Hierarchy

The bot enforces this hierarchy (higher roles inherit lower permissions):
```
administrator > moderator > head_organizer > officer > security > organizer > team > verified_raider
```

A user with the `officer` role can use commands that require `organizer`, `security`, or `verified_raider` permissions.

---

## 4. Channel Mapping

Configure where the bot sends logs and creates panels.

### Internal Channels

| Internal Key | Purpose | Required? |
|--------------|---------|-----------|
| `raid` | Main raid posts | **Yes** |
| `veri_log` | Verification logs | Recommended |
| `manual_verification` | Manual review requests | If using manual verification |
| `getverified` | Public verification instructions | Optional |
| `punishment_log` | Moderation actions log | Recommended |
| `raid_log` | Raid event logs | Recommended |
| `quota` | Quota leaderboards | If using quota system |
| `bot_log` | General bot activity | Recommended |
| `staff_updates` | Staff promotions | Optional |
| `modmail` | Support ticket forum | If using modmail |
| `role_ping` | Self-assign dungeon pings | Optional |
| `party_finder` | User-created parties | Optional |

### Configure with `/setchannels`

```
/setchannels
  raid: #raids
  veri_log: #verification-log
  punishment_log: #mod-log
  raid_log: #raid-log
  quota: #leaderboard
  bot_log: #bot-log
```

**Recommended baseline channels:**
- `raid` — for run posts
- `veri_log` — for verification tracking (logs all verification events)

### Example Setup

```
/setchannels
  raid: #raids
  veri_log: #staff-logs
  manual_verification: #manual-verify
  punishment_log: #staff-logs
  raid_log: #staff-logs
  quota: #leaderboard
  bot_log: #bot-activity
  modmail: #support-tickets
  party_finder: #party-finder
```

> **Tip:** Multiple internal channels can map to the same Discord channel if you want consolidated logs.

---

## 5. Test Verification

Verify the setup is working:

1. **Configure verification panel** (optional):
   - Use `/configverification` to customize the verification system
   - See [verification.md](verification.md) for detailed configuration options

2. **Verify yourself:**
   ```
   /verify
   ```
   - The bot will DM you with instructions
   - Follow the RealmEye verification flow
   - Confirm you receive the `verified_raider` role

3. **Check logs:**
   - Verification event should appear in the channel mapped to `veri_log`
   - If nothing appears, review channel permissions (bot needs Send Messages, Embed Links)

---

## 6. Next Steps

After successful setup:

1. **[Configure Verification](verification.md)** — Customize verification requirements
2. **[Create a Test Run](raid-management.md)** — Try `/run` to test raid system
3. **[Set Up Quota](quota-system.md)** — Configure organizer requirements (optional)
4. **[Review Moderation](moderation.md)** — Familiarize staff with moderation tools

---

## Troubleshooting

### Bot doesn't respond to commands

**Check:**
- Bot is online in Discord (green status)
- Bot has "Use Application Commands" permission in your server
- Commands are registered: look for them in Discord's slash command menu
- Check `docker-compose logs bot` for errors

**Fix:**
```bash
docker-compose restart bot
```

### `/setroles` or `/setchannels` says "Access Denied"

**Cause:** You need either Discord **Administrator** permission OR the mapped `administrator` role.

**Fix:**
- Grant yourself Discord Administrator permission in Server Settings → Roles, OR
- Have someone with Administrator permission map your role as `administrator` using `/setroles`
- Server owners always have sufficient permissions

### Verification doesn't grant role

**Check:**
- Bot's role is **above** the `verified_raider` role in Server Settings → Roles
- Bot has "Manage Roles" permission
- The `verified_raider` role is correctly mapped with `/setroles`

**Fix:**
1. Go to Server Settings → Roles
2. Drag the bot's role above all roles it needs to manage
3. Save and retry verification

### Database connection errors

**Docker setup:**
```bash
docker-compose down
docker-compose up -d
```

**Manual setup:**
- Verify PostgreSQL is running: `psql -U postgres -d rotmg_raids`
- Check `DATABASE_URL` in `.env` files
- Ensure database `rotmg_raids` exists

### "Backend API key mismatch" errors

**Cause:** `BACKEND_API_KEY` doesn't match between `backend/.env` and `bot/.env`.

**Fix:**
1. Open both `.env` files
2. Ensure `BACKEND_API_KEY` is identical
3. Restart both services:
   ```bash
   docker-compose restart backend bot
   ```

### Commands execute but nothing happens

**Check:**
- Backend logs: `docker-compose logs backend`
- Look for 500 errors or database issues
- Run migrations: `docker-compose exec backend npm run migrate`

### Role hierarchy issues

**Problem:** Bot can't assign roles or take moderation actions.

**Fix:**
1. Server Settings → Roles
2. Ensure bot role is positioned **above**:
   - `verified_raider`
   - `suspended`
   - `muted`
   - Any other roles it needs to manage
3. Do NOT place bot role above admin/moderator roles (unnecessary and risky)

---

## Advanced Configuration

### Custom Port Mapping

Edit `docker-compose.yml` to change exposed ports:
```yaml
ports:
  - "8080:4000"  # Backend on port 8080
```

### Production Deployment

For production:
1. Use strong `BACKEND_API_KEY` (generate with `openssl rand -hex 32`)
2. Use separate PostgreSQL instance (not Docker)
3. Enable SSL for backend (reverse proxy recommended)
4. Set `NODE_ENV=production` in `.env` files
5. Use process manager (PM2) or container orchestration

### Backup Strategy

**Database backup:**
```bash
docker-compose exec db pg_dump -U postgres rotmg_raids > backup.sql
```

**Restore:**
```bash
cat backup.sql | docker-compose exec -T db psql -U postgres rotmg_raids
```

---

## Summary

You've completed setup when:
- ✅ Bot is online and responds to commands
- ✅ `/setroles` configured for at least: administrator, security, organizer, verified_raider
- ✅ `/setchannels` configured for at least: raid, veri_log
- ✅ Test verification works and grants correct role
- ✅ No errors in logs

**Next:** [Configure verification settings →](verification.md)
