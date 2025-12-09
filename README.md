# ROTMG Raid Bot

A Discord bot for organizing **Realm of the Mad God** raids with automated run management, dual verification, moderation tools, and quota tracking for staff.

**Version:** 1.1  
**Status:** Production ready (actively maintained)  
**Last Updated:** November 17, 2025  

**Dungeoneer:** Discord.gg/o3  
**Support Server:** Discord.gg/87fq2cpjxD

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Installation](#installation)
  - [Prerequisites](#prerequisites)
  - [Option 1: Docker (Recommended)](#option-1-docker-recommended)
  - [Option 2: Manual Setup](#option-2-manual-setup)
- [Initial Discord Setup](#initial-discord-setup)
- [Usage](#usage)
  - [Running Raids](#running-raids)
  - [Verification System](#verification-system)
  - [Moderation Tools](#moderation-tools)
  - [Quota & Points](#quota--points)
- [Command Overview](#command-overview)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)
- [Acknowledgments](#acknowledgments)
- [Support](#support)

---

## Overview

ROTMG Raid Bot is a two-part system:

- A **Discord.js bot** that handles slash commands, buttons, and Discord events.
- A **Fastify backend** with a **PostgreSQL** database that stores runs, verification data, punishments, quota, key pops, logs, and more.

It’s designed for large raiding guilds that need:

- Structured raiding  
- Enforced verification  
- Serious moderation tools  
- Transparent activity tracking for staff  

---

## Features

### Run & Headcount Management

- Interactive raid panels with **join buttons** for raiders
- Headcount panels with **up to 10 dungeons** per headcount
- Key pop windows with **30-second countdown**
- Automatic run ending after a set duration (currently 2 hours)
- Organizer-only controls (Start, End, Pop Keys, Cancel)
- Raid thread logging in a dedicated channel for better organization

### Verification System

- **Automated RealmEye verification**
  - DM flow, verification code, profile check, role assignment
- **Manual screenshot verification**
  - Ticket-style review in a staff channel
  - Security+ staff approve/deny with reasons
- One IGN per member, with **alt IGN support**
- Automatic nickname updates and role assignment
- Full audit trail for verification actions

### Moderation Tools

- Warnings (`/warn`)
- Timed suspensions with automatic unsuspend (`/suspend`)
- Mutes (`/mute`)
- Bans, softbans, kicks
- Staff notes (private to Security+)
- Punishment history with pagination (`/checkpunishments`)
- All actions logged to a moderation log channel and database

### Quota & Points

- Organizer quota tracking (runs completed / verifications done)
- Raider points tracking (runs, key pops)
- Decimal point support (e.g. 0.5, 1.25)
- Per-dungeon and per-role point overrides
- Auto-updating leaderboard panels in a quota channel
- Manual adjustments for corrections and special cases

### Logging & Analytics

- Command execution logging (command, user, success/failure, latency)
- Raid thread logging
- Bot activity logging to a dedicated channel (optional)
- Database audit log for configuration, punishments, verifications, etc.

---

## Architecture

The system consists of three main components:

1. **Discord Bot (Discord.js)**
   - Handles slash commands, button clicks, select menus, scheduled tasks.
   - Communicates with the backend via HTTP using an API key.

2. **Backend API (Fastify)**
   - REST API for runs, verification, punishments, quota, notes, and command logs.
   - Enforces role-based permissions using guild-specific role mappings.
   - Uses PostgreSQL and SQL migrations for schema management.

3. **Database (PostgreSQL)**
   - Stores guild config (roles, channels), raiders, runs, reactions, punishments, notes, quota events, key pops, verification sessions, and command logs.

**High-level flow:**

```text
Discord User → Bot → Backend API → PostgreSQL
PostgreSQL → Backend API → Bot → Discord UI → Discord User
```

---

## Tech Stack

| Component  | Technology         | Why                                      |
|-----------|--------------------|------------------------------------------|
| Bot       | Discord.js 14      | Mature, well-maintained Discord library |
| Backend   | Fastify            | Fast, low-overhead, great TS support    |
| Database  | PostgreSQL 14+     | Reliable relational database            |
| Language  | TypeScript         | Type safety across bot & backend        |
| Runtime   | Node.js 18+        | Modern JS features, LTS                 |
| Validation| Zod                | Runtime schema validation               |
| Deploy    | Docker Compose 3.9 | Consistent dev/prod environment         |

---

## Installation

### Prerequisites

- **Node.js 18+**
- **Docker & Docker Compose** (recommended)  
  or **PostgreSQL 14+** if running manually
- A **Discord bot application** and **bot token** from the  
  [Discord Developer Portal](https://discord.com/developers/applications)

---

### Option 1: Docker (Recommended)

**1. Clone the repository**

```bash
git clone <your-repo-url>
cd rotmg-raid-bot
```

**2. Create `backend/.env`**

```env
PORT=4000
BACKEND_API_KEY=your_secret_key_here_make_it_long
DATABASE_URL=postgres://postgres:postgres@db:5432/rotmg_raids
```

**3. Create `bot/.env`**

```env
APPLICATION_ID=your_discord_app_id
SECRET_KEY=your_discord_bot_token
DISCORD_DEV_GUILD_ID=your_test_server_id
BACKEND_URL=http://backend:4000/v1
BACKEND_API_KEY=your_secret_key_here_make_it_long
```

> The `BACKEND_API_KEY` **must match** in both `.env` files.

**4. Start services**

```bash
docker-compose up -d
```

First startup will:

- Install dependencies  
- Run database migrations  
- Register slash commands  

Check the bot logs:

```bash
docker-compose logs -f bot
```

Look for lines like:

- `Successfully registered X commands`  
- `Bot is ready!`  

---

### Option 2: Manual Setup

Useful for local development without Docker.

#### Backend

```bash
cd backend
npm install
npm run migrate  # Run database migrations
npm run dev      # Start backend with hot reload
```

#### Bot

```bash
cd bot
npm install
npm run register # Register slash commands with Discord
npm run dev      # Start bot with hot reload
```

Make sure PostgreSQL is running and `DATABASE_URL` in `backend/.env` points to a valid database.

---

## Initial Discord Setup

Once the bot is online in your guild, configure it in Discord.

### 1. Configure Roles (Required)

Map your internal roles to Discord roles:

```text
/setroles
  administrator: @Admin
  moderator: @Moderator
  officer: @Officer
  security: @Security
  organizer: @Raid Leader
  verified_raider: @Verified
  suspended: @Suspended
  team: @Team
```

At **minimum**, set:

- `organizer`  
- `security`  
- `verified_raider`  

### 2. Configure Channels (Recommended)

Tell the bot where to post logs and panels:

```text
/setchannels
  raid: #raids
  veri_log: #verification-log
  punishment_log: #moderation-log
  raid_log: #raid-threads
  quota: #quota-leaderboards
  getverified: #get-verified
  manual_verification: #manual-verifications
  bot_log: #bot-activity
```

### 3. Smoke Test

Create a test run:

```text
/run dungeon:Shatters
```

You should see:

- An embed in your raid channel  
- Buttons for Join / Leave / Organizer Panel  

If that works, basic setup is good.

---

## Usage

### Running Raids

**Create a run:**

```text
/run dungeon:Shatters party:Nexus2 location:USEast description:Bring priest pls
```

Flow:

1. Bot creates a run in the backend  
2. Posts an embed with buttons  
3. Raiders click **Join** to participate  
4. Organizer clicks **Organizer Panel** for:
   - Start  
   - End  
   - Pop Keys (key window)  
   - Cancel  

If no one ends it, the run auto-ends after the configured duration (currently 2 hours).

**Headcounts:**

```text
/headcount
```

- Select up to **10 dungeons**.  
- Raiders join and mark which dungeons they have keys for.  
- Organizer can **convert to run** or **end** the headcount.  
- Creates a thread in the raid log channel for discussion/logging.  

---

### Verification System

There are two verification paths plus manual override.

#### 1. Automatic RealmEye Verification

Setup:

```text
/configverification send-panel channel:#get-verified
```

User experience:

1. Clicks **Get Verified** button.  
2. Bot DMs them for IGN.  
3. Bot gives them a code to add to their RealmEye profile.  
4. Bot checks RealmEye and verifies automatically.  
5. Assigns Verified Raider role and sets nickname.  

#### 2. Manual Screenshot Verification

Same panel, different button:

1. User uploads a vault screenshot with their Discord tag visible.  
2. Bot creates a ticket in `#manual-verifications`.  
3. Security+ can **Approve** or **Deny** via buttons.  
4. Bot assigns roles / sends DM with result.  
5. All actions are logged.  

#### 3. Manual Override

Security can force-verify someone:

```text
/verify member:@Player ign:TheirIGN
```

This handles:

- IGN conflicts  
- Role assignment  
- Nickname updates  
- Logging to verification log  

---

### Moderation Tools

**Warn a member:**

```text
/warn member:@Player reason:Rushing and dying repeatedly
```

**Suspend a member (timed):**

```text
/suspend member:@Player duration_days:3 reason:Repeated rule violations
```

- Suspended role is applied immediately.  
- Bot automatically removes the role when time expires.  

**Check history:**

```text
/checkpunishments member:@Player
```

Shows:

- Warnings  
- Suspensions  
- Staff notes (Security+ only)  
- Paginated if needed  

**Staff notes (silent):**

```text
/addnote member:@Player note:Watch for risky behavior in runs
```

Notes are private to Security+ and show up in `/checkpunishments`.

---

### Quota & Points

Quota tracks staff activity; points track raider activity.

#### Setup

Configure quota for a role:

```text
/configquota role:@Raid Leader
```

From the interactive panel you can:

- Set **required points** (e.g. 10 per period)  
- Set **reset datetime** (absolute UTC datetime)  
- Configure per-dungeon point overrides  
- Create/update a **leaderboard panel** in your quota channel  

Configure raider point values:

```text
/configpoints
```

- Set points per dungeon for raiders  
- Supports decimal values (e.g. 0.5, 1.25)  

#### Automatic Tracking

- Ending a run → logs a quota event for the organizer.  
- Verifying a raider → logs a quota event for the verifier.  
- Logging key pops → awards points based on dungeon configuration.  

#### Manual Adjustments

```text
/logrun dungeon:Shatters amount:1                # Adjust quota by +1
/logkey member:@Raider dungeon:Shatters amount:1 # Log key pops
/addquotapoints member:@Officer amount:3         # Direct quota adjustment
/addpoints member:@Raider amount:5               # Direct raider points adjustment
```

#### View Stats

```text
/stats                    # Your own stats
/stats member:@OtherUser  # Someone else
```

---

## Command Overview

> This is a **high-level** overview, not an exhaustive reference.

### General

- `/ping` – Check bot latency.  
- `/help [category]` – Show commands, with optional category filtering.  
- `/stats [member]` – View quota / points stats.  

### Organizer

- `/run` – Create a raid run.  
- `/headcount` – Create a multi-dungeon interest check.  
- `/logrun` – Manually log run completion.  
- `/logkey` – Log key pops.  

### Verification & Moderation

- `/verify` / `/unverify` / `/editname` / `/addalt` / `/removealt`  
- `/warn` / `/suspend` / `/unsuspend`  
- `/mute` / `/unmute`  
- `/kick` / `/ban` / `/unban` / `/softban`  
- `/checkpunishments` / `/removepunishment`  
- `/addnote`  
- `/addpoints` / `/addquotapoints`  

### Configuration

- `/setroles` – Map internal roles to Discord roles.  
- `/setchannels` – Map internal channels to Discord channels.  
- `/configquota` – Configure quota for a role.  
- `/configpoints` – Configure raider points.  
- `/configverification` – Send verification panel.  
- `/configrolepings` / `/sendrolepingembed` (if using role ping system).  
- `/syncteam` – Sync the Team role for all staff.  

### Modmail (If enabled in your setup)

- `/modmail` – Send a message to staff.  
- `/modmailreply` – Reply to a modmail ticket.  
- `/modmailblacklist` / `/modmailunblacklist` – Block/unblock users from modmail.  

---

## Troubleshooting

**Bot not responding to commands**

- Check logs:  
  `docker-compose logs bot | grep "Successfully registered"`  
- Ensure bot has:
  - Send Messages  
  - Embed Links  
  - Manage Roles  
- Run `/setroles` and `/setchannels` at least once.  

**"NOT_ORGANIZER" or similar permission errors**

- Make sure the Organizer role is correctly mapped in `/setroles`.  
- Check that you actually have that role.  
- Ensure the bot can see your roles (no weird role restrictions).  

**Backend connection errors**

- `BACKEND_URL` in `bot/.env` must point to the backend (`http://backend:4000/v1` in Docker).  
- `BACKEND_API_KEY` must match between `bot/.env` and `backend/.env`.  
- Use `docker-compose logs backend` to check backend errors.  

**Database migration failures**

- Verify PostgreSQL is running.  
- Check `DATABASE_URL` is properly formatted.  
- Look at `backend/src/db/migrations/` to see which migration failed.  
- For a fresh environment, you may need to drop the DB and re-run migrations.  

**Verification not working**

- Ensure `getverified` and `manual_verification` are configured in `/setchannels`.  
- RealmEye might be down; try again later.  
- Users must allow DMs from the server for DM-based verification.  

**Quota panels not updating**

- Ensure `quota` channel is set in `/setchannels`.  
- Bot needs send & edit permissions in that channel.  
- Role configured in `/configquota` must exist and have members.  
- Try ending a run or using `/logrun` to trigger an update.  

**Role management 403 errors**

- Bot’s role must be **higher** than the roles it needs to manage.  
- Check server role hierarchy.  
- Bot needs `Manage Roles` permission.  
- It cannot manage server owners and some admins (Discord limitation).  

---

## Contributing

Contributions are welcome.

### How to Start

1. Fork this repo.  
2. Set up the dev environment (see [Installation](#installation)).  
3. Pick something from:
   - [Troubleshooting](#troubleshooting)  
   - Known limitations (e.g. no bench/leave buttons, no `/runhistory`)  
4. Open a PR with:
   - Clear description  
   - Steps to reproduce / test  
   - Notes on breaking changes (if any)  

### Code Style

- Use **TypeScript** everywhere.  
- Prefer small, focused functions.  
- Use **Zod** for input validation.  
- Keep error messages clear and user-facing where relevant.  

---

## License

Not yet specified.

If you plan to make this fully open-source, adding an `MIT` license is a good default (and is friendly for community projects).

---

## Acknowledgments

Built for the ROTMG community by raiders who got tired of managing runs in spreadsheets.

Thanks to:

- The **Discord.js** maintainers  
- The **Fastify** team  
- Everyone who has tested the bot, reported bugs, or suggested features  

---

## Support

If you run into issues:

1. Check the [Troubleshooting](#troubleshooting) section first.  
2. Search existing GitHub issues.  
3. If needed, open a new issue including:
   - What you tried to do  
   - What happened instead  
   - Relevant log snippets (`docker-compose logs`)  
   - Your setup (Docker vs manual, OS, etc.)  
