# ROTMG Raid Bot

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A Discord bot for organizing **Realm of the Mad God** raids. It includes interactive runs and headcounts, RealmEye and screenshot verification, moderation tools, party finding, configurable role pings, and staff quota tracking.

**[View the detailed documentation](docs/README.md)** for focused setup, raid, verification, moderation, and quota guides.

---

## Features

- **Raid management:** Single and multi-dungeon runs, organizer controls, temporary run roles, key offers, and automatic cleanup.
- **Headcounts:** Up to five dungeon choices, per-dungeon interest buttons, key quantities, and conversion into a run.
- **Oryx 3:** Taken screenshot enforcement, Realm Closed progression, miniboss and third-room controls, and O3 chaining.
- **Verification:** Self-service RealmEye verification, manual screenshot review, staff verification commands, and custom role verification panels.
- **Quota and stats:** Role-specific quota periods, rollover, run and minute credit, moderation credit, leaderboards, and per-dungeon activity statistics.
- **Moderation and communication:** Warnings, suspensions, mutes, bans, notes, modmail, party finder, and configurable logs.

## Tech Stack

- **Bot:** Discord.js 14, TypeScript
- **Backend:** Fastify, Node.js 20
- **Database:** PostgreSQL 14
- **Development environment:** Docker Compose

## Installation

### Prerequisites

- Docker and Docker Compose, recommended
- A Discord application and bot token from the [Discord Developer Portal](https://discord.com/developers/applications)

### Quick Start with Docker

1. Clone the repository.

   ```bash
   git clone <repo-url>
   cd rotmg-raid-bot
   ```

2. Copy or create `backend/.env` and `bot/.env`. `BACKEND_API_KEY` must match in both files.

   `backend/.env`:

   ```env
   PORT=4000
   BACKEND_API_KEY=your_secret_key
   DATABASE_URL=postgres://postgres:postgres@db:5432/rotmg_raids
   NODE_ENV=production
   ```

   `bot/.env`:

   ```env
   APPLICATION_ID=your_app_id
   SECRET_KEY=your_bot_token
   DISCORD_GUILD_IDS=your_guild_id
   BACKEND_URL=http://backend:4000/v1
   BACKEND_API_KEY=your_secret_key
   NODE_ENV=production
   ```

3. Build and start the production services.

   ```bash
   docker compose up -d --build
   ```

The default Compose file builds production images. The backend runs migrations
before starting the compiled API, and the bot runs its compiled entry point.

Register slash commands after the initial setup or after changing command names or options:

```bash
docker compose run --rm bot npm run register
```

### Local Development with Docker

Add the development overlay to use source bind mounts, persistent dependency
volumes, automatic dependency reconciliation, and `tsx watch`:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

Package manifest changes are reconciled automatically at container startup.
Use `--build` after changing a Dockerfile or a development entrypoint.

Register commands from the development image with:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml run --rm bot npm run register:dev
```

### Manual Development

Run PostgreSQL, set the backend `DATABASE_URL`, and use separate terminals for the two services:

```bash
cd backend
npm ci
npm run migrate
npm run dev
```

```bash
cd bot
npm ci
npm run register:dev
npm run dev
```

For local development outside Docker, set the bot's `BACKEND_URL` to `http://localhost:4000/v1`.

## Permissions

Mapped bot roles follow this hierarchy:

`Administrator > Moderator > Head Organizer > Officer > Security > Organizer > Verified Raider`

A command marked with `+` can also be used by higher roles. `/setroles`, `/setchannels`, `/sendrolepingembed`, and `/createrole` specifically require the Discord **Administrator** permission rather than a mapped bot role.

## Configuration

Configure these systems before opening the bot to members:

| Command | Permission | Purpose |
| --- | --- | --- |
| `/setroles` | Discord Administrator | Map Discord roles to bot roles, plus Team, Suspended, and Muted roles. |
| `/setchannels` | Discord Administrator | Configure raid, Active Runs, verification, moderation, quota, modmail, role-ping, party-finder, early-location, bot-bait, and log channels. |
| `/configrolepings` | Moderator+ | Assign or remove the role ping used for a dungeon's runs and headcounts. |
| `/sendrolepingembed` | Discord Administrator | Post the self-service dungeon ping-role panel in the configured role-ping channel. |
| `/configquota role:<role>` | Moderator+ | Configure a role's quota target, interval, rollover, point sources, overrides, and leaderboard panel. |
| `/configpoints` | Moderator+ | Configure raider completion and key-pop points. |
| `/configverification` | Moderator+ | Post and customize the verification panel and RealmEye or manual instructions. |
| `/setdungeonimage` | Moderator+ | Set the PNG, JPEG, or WebP image posted after eligible single-dungeon raid panels. |
| `/createrole` | Discord Administrator | Create a custom screenshot-review panel that grants a selected Discord role. |

At minimum, map the roles used by your staff and configure a `raid` channel. Configure `active_runs` to maintain a separate mirror of every Starting Soon or Live run. Headcounts are not mirrored there. Configure `quota` for live quota panels and `quota_log` for finalized-period results.

## Runs and Headcounts

### Runs

`/run dungeon:<name>` creates a single-dungeon run. Omitting `dungeon` opens a selector for up to five compatible dungeons. Multi-runs may contain exalts or non-exalts, but not a mixture of both. Realm Clearing may accompany non-exalts, and Oryx 3 must be selected alone.

Runs are posted in the configured raid channel as a **Starting Soon** panel. The organizer receives a private organizer panel for setting party and location, editing details, managing joins, logging Dungeon Entered events, moving the run to **Live**, and ending or cancelling it. Party and location must be set before the run can go Live.

Members can join or leave, select a class, and offer eligible keys, incs, or runes. A key offer asks for a quantity from 1 to 10 and can be updated or withdrawn. The organizer sees offered quantities in the organizer panel. Normal run completion no longer opens a post-run key logger; `/logkey` remains available for manual key corrections.

Runs automatically end after two hours by default, with expiry checks every five minutes. Ending or cancelling removes public controls, clears reactions, removes the temporary run role, and removes the Active Runs mirror.

If a configured image exists, the bot posts it immediately after an eligible single-dungeon or O3 raid panel. Multi-dungeon and Realm Clearing runs do not receive a dungeon image.

### Oryx 3

O3 runs require `/taken screenshot:<file>` before they can be moved to Live. The organizer panel then supports Realm Closed, realm score, miniboss, and third-room progression. After an O3 is completed normally, the organizer can create one chained successor from the closed panel; the new run keeps the prior run's party, location, and description.

### Headcounts

`/headcount` opens a selector for up to five dungeons and posts the result in the raid channel. Each selected dungeon gets its own Interested button, so members can express interest in only the runs they want. Eligible dungeons also get key, inc, or rune buttons with quantities from 1 to 10.

The private organizer panel shows interest and key offers per dungeon. It can end the headcount or convert a selected dungeon into a run while transferring applicable interest and key offers. Headcounts automatically close after two hours, are not shown in the Active Runs channel, and are stored in memory only.

## Quotas, Points, and Activity

Quota is configured separately for each Discord role with `/configquota role:<role>`. Each active period snapshots its target and rollover setting. Periods finalize automatically at their configured day interval, preserve results in history, and post member results to `quota_log` when that channel is configured. With rollover enabled, surplus credit carries into the next period up to that period's required amount.

Organizer activity is credited according to the run type:

- **Exalt and multi-exalt runs:** Organizer credit is recorded for each Dungeon Entered event. Dungeon overrides can replace the role's base exalt value.
- **Oryx 3:** Organizer completion credit is recorded when the run ends successfully.
- **Single or multi non-exalt runs and Realm Clearing:** Credit is based on confirmed whole minutes at the configured per-minute rate. The organizer can adjust the duration before confirming it after the run ends, or recover a missed prompt with `/logminutes`. Optional non-exalt or dungeon-specific points are additive for each Dungeon Entered event.
- **Verification and moderation:** Configurable points can be awarded for verification, warnings, suspensions, modmail replies, IGN edits, and notes. The verification value applies to `/verify` and to completed manual screenshot reviews, whether approved or denied.

`/stats` shows raider points, quota points, runs organized, non-exalt run time, verifications, key pops, and per-dungeon completion, key, and organizer totals. `/leaderboard` can rank runs organized, keys popped, dungeon completions, raider points, or quota points with dungeon and date filters.

## Command Reference

### Everyone and Verified Raiders

| Command | Permission | Purpose |
| --- | --- | --- |
| `/modmail` | Everyone | Send a private support message to staff. |
| `/party` | Verified Raider+ | Post a party finder entry with up to five dungeons. |
| `/stats` | Verified Raider+ | View your own or another member's activity statistics. |
| `/leaderboard` | Verified Raider+ | View filtered guild activity and points leaderboards. |
| `/ping` | Verified Raider+ | Check the bot and backend response latency. |

### Organizers

| Command | Permission | Purpose |
| --- | --- | --- |
| `/run` | Organizer+ | Create a raid run in the configured raid channel. |
| `/headcount` | Organizer+ | Create a single or multi-dungeon interest check. |
| `/taken` | Organizer+ | Submit the required taken screenshot for your active O3. |
| `/logrun` | Organizer+ | Manually add or remove run activity and its configured quota credit. |
| `/logkey` | Organizer+ | Manually add or remove key pops and configured key points. |
| `/logminutes` | Original organizer | Recover minute credit for an eligible ended run. |
| `/find` | Organizer+ | View a member's verification, notes, and punishment history. |
| `/listrole` | Organizer+ | List up to 250 members who have a selected Discord role. |
| `/help` | Organizer+ | List commands by permission or show help for one command. |

### Security and Officers

| Command | Permission | Purpose |
| --- | --- | --- |
| `/verify`, `/unverify` | Security+ | Add or remove a member's verification. |
| `/editname`, `/addalt`, `/removealt` | Security+ | Maintain verified member IGNs. |
| `/warn` | Security+ | Record a warning. |
| `/suspend`, `/unsuspend` | Security+ | Add or remove a raid suspension. |
| `/mute`, `/unmute` | Security+ | Add or remove a timed server mute. |
| `/addnote`, `/removepunishment` | Security+ | Add a staff note or remove a note or punishment by ID. |
| `/purge` | Security+ | Delete up to 25 recent messages in a channel. |
| `/modmailreply` | Security+ | Reply from a modmail ticket thread. |
| `/addpoints` | Officer+ | Manually adjust raider points. |
| `/addquotapoints` | Officer+ | Adjust a member's points for a selected quota role. |
| `/addrole` | Officer+ | Add an allowed lower staff role to a member. |
| `/kick`, `/ban`, `/unban`, `/softban` | Officer+ | Perform server removal and ban actions. |
| `/modmailblacklist`, `/modmailunblacklist` | Officer+ | Manage access to modmail. |

### Moderators and Administrators

| Command | Permission | Purpose |
| --- | --- | --- |
| `/configquota` | Moderator+ | Configure role-specific quota and period behavior. |
| `/configpoints` | Moderator+ | Configure raider completion and key-pop points. |
| `/configrolepings` | Moderator+ | Configure dungeon-specific ping roles. |
| `/configverification` | Moderator+ | Configure and post the verification panel. |
| `/setdungeonimage` | Moderator+ | Set the image for a dungeon's eligible raid panels. |
| `/syncteam` | Administrator+ | Synchronize the Team role for all mapped staff. |
| `/forcesync` | Administrator+ | Import or update verified member records from Discord nicknames. |
| `/setroles`, `/setchannels` | Discord Administrator | Configure guild role and channel mappings. |
| `/sendrolepingembed` | Discord Administrator | Post the dungeon ping-role panel. |
| `/createrole` | Discord Administrator | Create a custom role verification panel. |

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
