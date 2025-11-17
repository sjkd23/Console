# ROTMG Raid Bot# ROTMG Raid Bot



A Discord bot for organizing Realm of the Mad God raid runs with automated coordination, verification, moderation, and quota tracking.A Discord bot for organizing Realm of the Mad God raid runs with automated coordination, verification, moderation, and quota tracking.



**Version:** 0.3.0**Version:** 0.3.0



## Quick Links## Quick Links



- [Installation](#installation)- [Installation](#installation)

- [Initial Setup](#initial-setup)- [Initial Setup](#initial-setup)

- [Commands](#commands)- [Commands](#commands)

- [Architecture](#architecture)- [Architecture](#architecture)

- [Troubleshooting](#troubleshooting)- [Troubleshooting](#troubleshooting)

- [Contributing](#contributing)- [Contributing](#contributing)



---## Overview



## OverviewBuilt with **Discord.js** (bot), **Fastify** (backend API), and **PostgreSQL** (database).



Built with **Discord.js** (bot), **Fastify** (backend API), and **PostgreSQL** (database).**Features:**

- Interactive raid panels with class selection

**Key Features:**- Dual verification (RealmEye + manual screenshot)

- Interactive raid panels with class selection and auto-end after 2 hours- Moderation system with auto-expiring suspensions

- Dual verification (RealmEye automated + manual screenshot review)- Quota tracking for organizers and raiders

- Moderation with auto-expiring suspensions and warning system- Headcount system for interest checks

- Quota tracking for organizers and raiders with configurable points- Automated run management

- Headcount system for gauging interest before full runs

- Thread-based raid logging and staff notes



---------



## Installation



### Prerequisites## Features## Features



- Node.js 18+

- Docker & Docker Compose (recommended) or PostgreSQL 14+

- Discord bot token from [Discord Developer Portal](https://discord.com/developers/applications)### Run Management### Run Management



### Docker Setup (Recommended)- Interactive raid panels with join buttons and class selection



Clone the repository:- Interactive raid panels with join buttons and class selection- Auto-updating participant counters and class distribution

```bash

git clone <your-repo-url>- Auto-updating participant counters and class distribution- Organizer controls for starting, ending, and managing runs

cd rotmg-raid-bot

```- Organizer controls for starting, ending, and managing runs- Support for party names, locations, and custom descriptions



Create `backend/.env`:- Support for party names, locations, and custom descriptions- Key pop windows with 30-second countdown timers

```env

PORT=4000- Key pop windows with 30-second countdown timers- Automatic run ending after 2 hours (configurable)

BACKEND_API_KEY=your_secret_key_here

DATABASE_URL=postgres://postgres:postgres@db:5432/rotmg_raids- Automatic run ending after 2 hours (configurable)- Oryx 3 screenshot submission via `/taken` command

```

- Oryx 3 screenshot submission via `/taken` command

Create `bot/.env`:

```env### Verification System

APPLICATION_ID=your_discord_app_id

SECRET_KEY=your_discord_bot_token### Verification System- **Automated (RealmEye)**: DM-based flow with profile verification

DISCORD_DEV_GUILD_ID=your_test_server_id

BACKEND_URL=http://backend:4000/v1- **Manual (Screenshot)**: Ticket-based review by Security+ staff

BACKEND_API_KEY=your_secret_key_here

```- **Automated (RealmEye)**: DM-based flow with profile verification- Configurable verification panels and custom instructions



**Important:** `BACKEND_API_KEY` must match in both files.- **Manual (Screenshot)**: Ticket-based review by Security+ staff- One IGN per member enforcement



Start services:- Configurable verification panels and custom instructions- Automatic nickname updates and role assignment

```bash

docker-compose up -d- One IGN per member enforcement- Alt IGN support for multi-account tracking

docker-compose logs -f bot  # watch startup

```- Automatic nickname updates and role assignment



### Manual Setup- Alt IGN support for multi-account tracking### Moderation Tools



**Backend:**- Warning system with history tracking

```bash

cd backend### Moderation Tools- Timed suspensions with automatic expiration

npm install

npm run migrate- Mute system with automatic unmute

npm run dev

```- Warning system with history tracking- Ban/unban/softban/kick commands



**Bot:**- Timed suspensions with automatic expiration- Staff notes visible only to Security+ roles

```bash

cd bot- Mute system with automatic unmute- Comprehensive punishment history with pagination

npm install

npm run register- Ban/unban/softban/kick commands- Full audit trail for all moderation actions

npm run dev

```- Staff notes visible only to Security+ roles



---- Comprehensive punishment history with pagination### Quota & Points System



## Initial Setup- Full audit trail for all moderation actions- Track organizer activity (runs completed per dungeon)



Configure the bot in Discord after startup:- Track raider activity (keys popped, run participation)



**1. Configure Roles (Required):**### Quota & Points System- Configurable point values per dungeon and role

```

/setroles- Auto-updating leaderboard panels

  organizer: @Raid Leader

  security: @Security- Track organizer activity (runs completed per dungeon)- Manual quota adjustments for corrections

  verified_raider: @Verified

  suspended: @Suspended- Track raider activity (keys popped, run participation)- Quota period management with configurable reset dates

```

- Configurable point values per dungeon and role- Separate systems for organizer quota and raider points

**2. Configure Channels (Recommended):**

```- Auto-updating leaderboard panels

/setchannels

  raid: #raids- Manual quota adjustments for corrections### Additional Features

  veri_log: #verification-log

  punishment_log: #moderation-log- Quota period management with configurable reset dates- Headcount system for multi-dungeon interest checks

  quota: #quota-boards

```- Separate systems for organizer quota and raider points- Dungeon autocomplete showing recently used dungeons



**3. Test:**- Modmail system for member-to-staff communication

```

/run dungeon:Shatters### Additional Features- Role ping system for dungeon notifications

```

- Automatic team role management for staff

---

- Headcount system for multi-dungeon interest checks- Command execution logging for analytics

## Commands

- Dungeon autocomplete showing recently used dungeons- Raid thread management for organized logging

### Run Management

| Command | Description | Required Role |- Modmail system for member-to-staff communication

|---------|-------------|---------------|

| `/run` | Create raid with dungeon autocomplete | Organizer |- Role ping system for dungeon notifications---

| `/headcount` | Multi-dungeon interest check | Organizer |

| `/logrun` | Manually log run completion | Organizer |- Automatic team role management for staff

| `/logkey` | Log key pops for raiders | Organizer |

- Command execution logging for analytics## Architecture

### Verification

| Command | Description | Required Role |- Raid thread management for organized logging

|---------|-------------|---------------|

| `/verify` | Manually verify member | Security |The system consists of three main components:

| `/unverify` | Remove verification | Security |

| `/editname` | Update IGN | Security |---

| `/configverification` | Send verification panel | Moderator |

- Node.js 18+

### Moderation

| Command | Description | Required Role |## Architecture- Docker & Docker Compose (easiest), or PostgreSQL 14+ if running manually

|---------|-------------|---------------|

| `/warn` | Issue warning | Security |- Discord bot token ([get one here](https://discord.com/developers/applications))

| `/suspend` | Timed suspension | Security |

| `/checkpunishments` | View punishment history | Security |The system consists of three main components:

| `/addnote` | Add staff note | Security |

| `/addpoints` | Adjust raider points | Officer |### Setup (Docker - Recommended)

| `/addquotapoints` | Adjust quota points | Officer |

### Discord Bot (Discord.js)

### Configuration

| Command | Description | Required Role |Clone the repo:

|---------|-------------|---------------|

| `/setroles` | Map Discord roles | Moderator |Handles all Discord interactions including slash commands, button clicks, and automated tasks. Communicates with the backend API via HTTP with API key authentication.

| `/setchannels` | Map channels | Moderator |

| `/configquota` | Configure quota system | Moderator |```bash

| `/configpoints` | Configure raider points | Moderator |

### Backend API (Fastify)git clone <your-repo-url>

### General

| Command | Description | Required Role |cd rotmg-raid-bot

|---------|-------------|---------------|

| `/stats` | View quota statistics | Anyone |REST API that manages all data operations, enforces permissions, and maintains the PostgreSQL database. Handles authorization, quota calculations, and data validation.```

| `/ping` | Check bot latency | Anyone |

| `/help` | Command reference | Organizer |



---### Database (PostgreSQL)Create `backend/.env`:



## Architecture



The system consists of three components:Stores all guild configurations, run data, member information, verification sessions, punishments, quota events, and audit logs. Uses 46+ migration files for schema management.```env



**Discord Bot (Discord.js):**PORT=4000

Handles all Discord interactions, slash commands, button clicks, and automated tasks. Communicates with backend via HTTP with API key authentication.

**Communication Flow:**BACKEND_API_KEY=your_secret_key_here

**Backend API (Fastify):**

REST API managing data operations, permissions, and database. Handles authorization, quota calculations, and validation.DATABASE_URL=postgres://postgres:postgres@db:5432/rotmg_raids



**Database (PostgreSQL):**```text```

Stores guild configs, runs, members, verification sessions, punishments, quota events, and audit logs. Uses 35+ migration files for schema.

Discord User → Bot (validates & defers) → Backend API (authorizes & processes) → Database

**Communication Flow:**

```Database → Backend API (returns data) → Bot (updates Discord UI) → Discord UserCreate `bot/.env`:

Discord User → Bot → Backend API → Database

Database → Backend API → Bot → Discord User```

```

```env

---

---APPLICATION_ID=your_discord_app_id

## Troubleshooting

SECRET_KEY=your_discord_bot_token

**Bot doesn't respond to commands**

- Check logs: `docker-compose logs bot | grep "Successfully registered"`## InstallationDISCORD_DEV_GUILD_ID=your_test_server_id

- Verify bot has Send Messages, Embed Links, Manage Roles permissions

- Run `/setroles` to configure at least organizer and verified_raiderBACKEND_URL=http://backend:4000/v1



**"NOT_ORGANIZER" error**### PrerequisitesBACKEND_API_KEY=your_secret_key_here

- Ensure you have the Organizer role configured in `/setroles`

- Verify you have that Discord role assigned```



**Backend connection errors**- Node.js 18+ (LTS recommended)

- Check `BACKEND_URL` in bot/.env matches backend location

- Verify `BACKEND_API_KEY` is identical in both .env files- Docker & Docker Compose (recommended), or PostgreSQL 14+Make sure `BACKEND_API_KEY` matches in both files.

- If using Docker: `docker-compose logs` to check both services

- Discord bot token from [Discord Developer Portal](https://discord.com/developers/applications)

**Database migration failures**

- Check PostgreSQL is runningFire it up:

- Verify `DATABASE_URL` format: `postgres://user:pass@host:port/database`

- Look at `backend/src/db/migrations/` to see which failed### Quick Start with Docker (Recommended)



**Verification not working**```bash

- Set channels: `/setchannels getverified:#your-channel`

- For RealmEye: check if realmeye.com is accessible1. **Clone the repository**docker-compose up -d

- For manual: ensure manual_verification channel is configured

- Bot needs permission to send DMsdocker-compose logs -f bot  # watch it start



**Quota panels not updating**   ```bash```

- Verify quota channel set: `/setchannels quota:#your-channel`

- Bot needs send/edit message permissions in that channel   git clone <your-repo-url>

- Try completing a run to trigger an update

   cd rotmg-raid-botFirst run takes a minute - it's installing deps and running database migrations.

**Role management fails (403 errors)**

- Bot's role must be higher than roles it manages   ```

- Check Server Settings > Roles for hierarchy

- Bot needs "Manage Roles" permission### Setup (Manual)



---2. **Configure backend** - Create `backend/.env`:



## ContributingIf you don't want Docker:



### Getting Started   ```env



1. Fork and clone the repository   PORT=4000**Backend:**

2. Set up dev environment (see [Installation](#installation))

3. Pick something to work on   BACKEND_API_KEY=your_secure_random_key_here```bash

4. Test thoroughly before submitting

   DATABASE_URL=postgres://postgres:postgres@db:5432/rotmg_raidscd backend

### Testing

   NODE_ENV=productionnpm install

No automated tests yet. Test manually:

- Create runs and click buttons   ```npm run migrate  # set up database

- Test with different roles

- Try edge cases (missing config, invalid input)npm run dev

- Check database state after operations

3. **Configure bot** - Create `bot/.env`:```

### Pull Requests



- Clear description of changes

- Reference related issues   ```env**Bot:**

- Ensure bot starts and basic commands work

- Update README if adding features   APPLICATION_ID=your_discord_application_id```bash



### Areas That Need Help   SECRET_KEY=your_discord_bot_tokencd bot



- Unit/integration tests   DISCORD_DEV_GUILD_ID=your_test_server_id_optionalnpm install

- Environment variable validation on startup

- Bench/leave buttons in UI   BACKEND_URL=http://backend:4000/v1npm run register  # register commands with Discord

- Run history command

- Redis caching layer   BACKEND_API_KEY=your_secure_random_key_herenpm run dev

- Better error messages

   NODE_ENV=production```

---

   ```

## Tech Stack

### Configure Your Server

| Component | Technology | Why |

|-----------|-----------|-----|   **Important:** `BACKEND_API_KEY` must match in both files.

| Bot | Discord.js 14 | Best Discord library for Node.js |

| Backend | Fastify | Fast, low overhead, great TS support |Once the bot's online, run these in Discord:

| Database | PostgreSQL 14 | Reliable, handles relational data well |

| Language | TypeScript | Type safety catches bugs early |4. **Start all services**

| Runtime | Node.js 18+ | Modern JS features, stable LTS |

| Validation | Zod | Runtime type checking |**1. Map roles** (required):

| Deploy | Docker Compose | Consistent dev/prod environments |

   ```bash```

---

   docker-compose up -d/setroles

## Known Issues

   ```  organizer: @Raid Leader

**Missing Features:**

- No bench/leave buttons in UI (backend supports it)  security: @Security

- Can't view who joined a run except by counter

- No `/runhistory` command to browse past runs   First startup takes a few minutes to install dependencies and run database migrations.  verified_raider: @Verified

- Auto-end duration hardcoded at 2 hours

- No voice channel integration  suspended: @Suspended



**Bugs:**5. **Verify startup**```

- Missing env vars cause runtime errors instead of failing fast

- Race condition if two organizers click "End" simultaneously

- Quota reset doesn't happen automatically - manual "Reset Panel" needed

   ```bash**2. Map channels** (recommended):

**Performance:**

- No caching layer - every permission check hits database   docker-compose logs -f bot```

- No rate limiting on backend API

- Quota leaderboards fetch all members then filter   ```/setchannels



---  raid: #raids



## License   Look for: `Successfully registered X commands` and `Bot is ready!`  veri_log: #verification-log



Not specified. Consider adding a LICENSE file (MIT recommended for open source).  punishment_log: #moderation-log



---### Manual Installation  quota: #quota-boards



**Last Updated:** November 17, 2025  ```

**Version:** 0.3.0  

**Status:** Production readyIf you prefer running services directly:



For help, check [Troubleshooting](#troubleshooting) or open a GitHub issue.**3. Test it:**


**Backend:**```

/run dungeon:Shatters

```bash```

cd backend

npm installYou should see an embed with buttons. Click Join to test interactions.

npm run migrate  # Run database migrations

npm run dev      # Start with hot reload---

```

## How to Use

**Bot:**

### Running Raids

```bash

cd botThe `/run` command creates a raid post with buttons:

npm install

npm run register # Register slash commands with Discord```

npm run dev      # Start with hot reload/run dungeon:Shatters party:Nexus2 location:USEast

``````



Ensure PostgreSQL is running and `DATABASE_URL` in `backend/.env` points to your database.Autocomplete shows your server's recently used dungeons. Raiders click Join, pick their class, and you click Organizer Panel to Start/End the run. If you forget to end it, the bot does it automatically after 2 hours.



---For quick interest checks:



## Initial Configuration```

/headcount

After the bot is online, configure your Discord server:```



### 1. Configure Roles (Required)Pick up to 10 dungeons. People can join and mark which dungeons they have keys for. Convert to a full run when ready, or just cancel it.



Map your Discord roles to bot permission levels:### Verifying Members



```text**Automated (RealmEye):**

/setroles1. `/configverification send-panel channel:#get-verified`

  administrator: @Admin2. Users click "Get Verified"

  moderator: @Moderator3. Bot DMs them for their IGN

  head_organizer: @Head Organizer4. They add a code to their RealmEye profile

  officer: @Officer5. Bot verifies automatically

  security: @Security

  organizer: @Raid Leader**Manual (Screenshots):**

  verified_raider: @Verified1. Same panel, different button

  suspended: @Suspended2. User uploads vault screenshot with Discord tag visible

  muted: @Muted3. Creates a ticket in #manual-verifications

  team: @Team4. Security+ staff approve or deny

```

**Manual Override:**

**Minimum required:** `organizer`, `security`, and `verified_raider`Security staff can always force-verify someone:

```

### 2. Configure Channels (Recommended)/verify member:@Player ign:TheirIGN

```

Tell the bot where to post logs and panels:

### Moderation

```text

/setchannels**Warnings:**

  raid: #raids```

  veri_log: #verification-logs/warn member:@Player reason:Rushed and died

  punishment_log: #moderation-logs```

  raid_log: #raid-threads

  quota: #quota-leaderboards**Suspensions:**

  getverified: #get-verified```

  manual_verification: #manual-verifications/suspend member:@Player duration_days:3 reason:Repeated violations

  bot_log: #bot-activity```

  role_ping: #role-pings

```Bot assigns the Suspended role and removes it when time's up.



### 3. Test Basic Functionality**Check history:**

```

Create a test run to verify everything works:/checkpunishments member:@Player

```

```text

/run dungeon:ShattersShows warnings, suspensions, and staff notes. Paginated if there's lots.

```

**Staff notes** (silent warnings):

If you see an interactive embed with buttons, the bot is working correctly.```

/addnote member:@Player note:Watch this person

---```



## Usage GuideOnly Security+ can see these.



### Creating Runs### Quota System



Use `/run` to create raid panels:Track who's actively organizing and verifying. Optional but useful for promotions.



```text**Setup:**

/run dungeon:Shatters party:Nexus2 location:USEast description:Bring priests```

```/configquota role:@Raid Leader

```

**Features:**

Opens a panel where you:

- Dungeon autocomplete shows recently used dungeons- Set required points (e.g., "10 runs per month")

- Participants click "Join" and select their class- Set reset date (absolute datetime like "2025-12-01T00:00:00Z")

- Organizer Panel provides Start/End/Pop Keys controls- Override points per dungeon (Shatters = 3, Pirate Cave = 1)

- Runs automatically end after 2 hours if not manually ended- Create auto-updating leaderboard

- For Oryx 3 runs, use `/taken` to submit completion screenshot

Points are awarded automatically when runs end or people get verified. You can also manually adjust:

### Headcounts

```

Gauge interest before committing to full runs:/logrun dungeon:Shatters amount:1     # add quota points

/logkey member:@Raider dungeon:Shatters amount:1  # log key pops

```text/addquotapoints member:@Officer amount:5  # direct adjustment

/headcount```

```

View stats:

Select up to 10 dungeons. Members can join and indicate which dungeons they have keys for. Convert to a full run when ready, or cancel if interest is low.```

/stats  # your stats

### Member Verification/stats member:@Someone  # their stats

```

**Setup verification panel:**

---

```text

/configverification send-panel channel:#get-verified## Architecture

```

The bot has two main pieces:

**Verification methods:**

**Discord.js Bot** - Handles all Discord interactions (commands, buttons, events). When something happens, it calls the backend API.

- **RealmEye (Automated)**: Members receive DM, provide IGN, add code to RealmEye profile

- **Manual (Screenshot)**: Members upload vault screenshot, Security+ staff review ticket**Fastify Backend** - REST API that manages all the data in PostgreSQL. Handles authorization, runs CRUD operations, tracks quota, etc.



**Manual verification override:**They communicate via HTTP with API key authentication.



```text**Key flows:**

/verify member:@Player ign:TheirRotmgName

```*Creating a run:*

1. User runs `/run dungeon:Shatters`

### Moderation Commands2. Bot checks permissions via API

3. Bot creates run in database via `POST /runs`

**Warnings:**4. Bot posts embed with buttons in Discord

5. Database gets the Discord message ID for updates

```text

/warn member:@Player reason:Rushing and dying repeatedly*Ending a run:*

```1. Organizer clicks "End" button

2. Bot calls `PATCH /runs/:id` with status='ended'

**Suspensions (timed):**3. Backend logs quota event automatically

4. Backend calculates points based on dungeon config

```text5. Bot updates embed and refreshes quota leaderboards

/suspend member:@Player duration:3d reason:Multiple rule violations

```*Auto-role sync:*

1. Admin assigns @Raid Leader to someone

Suspended role is automatically removed when time expires.2. Bot detects role change event

3. Bot checks if they have any staff roles

**Check punishment history:**4. Bot automatically assigns @Team role

5. Reverse happens when staff roles removed

```text

/checkpunishments member:@Player active_only:false---

```

## Project Structure

**Staff notes (internal only):**

```

```textrotmg-raid-bot/

/addnote member:@Player note:Watch for continued behavior├── backend/                 # Fastify REST API

```│   ├── src/

│   │   ├── server.ts       # Main server

### Quota System│   │   ├── db/

│   │   │   ├── pool.ts     # PostgreSQL connection

**Configure quota for a role:**│   │   │   └── migrations/ # 32 migration files

│   │   ├── lib/            # Auth, logging, quota logic

```text│   │   ├── routes/         # API endpoints

/configquota role:@Raid Leader│   │   └── plugins/        # API key auth

```│   └── Dockerfile.dev

│

Set required points, reset datetime, and per-dungeon point overrides through the interactive panel.├── bot/                     # Discord.js Bot

│   ├── src/

**Manual adjustments:**│   │   ├── index.ts        # Bot client init

│   │   ├── commands/       # Slash commands

```text│   │   │   ├── run.ts

/logrun dungeon:Shatters amount:1              # Add organizer quota points│   │   │   ├── headcount.ts

/logkey member:@Raider dungeon:Shatters amount:1  # Log key pops│   │   │   ├── stats.ts

/addquotapoints member:@Officer amount:5         # Direct quota adjustment│   │   │   ├── configs/    # /setroles, /configquota, etc.

/addpoints member:@Raider amount:10             # Direct raider points adjustment│   │   │   └── moderation/ # /verify, /warn, /suspend, etc.

```│   │   ├── interactions/   # Button handlers

│   │   │   └── buttons/

**View statistics:**│   │   │       ├── raids/  # join, class selection, run status

│   │   │       ├── config/ # quota config, points config

```text│   │   │       └── verification/ # get-verified, approve/deny

/stats                # Your own stats│   │   ├── constants/      # 50+ dungeon definitions, classes, emojis

/stats member:@Player # Another member's stats│   │   ├── lib/            # HTTP client, permissions, logging

```│   │   └── services/       # RealmEye API integration

│   └── Dockerfile.dev

### Role Ping System│

└── docker-compose.yml       # Postgres + Backend + Bot

**Configure role pings for dungeons:**```



```text---

/configrolepings

```## Known Issues



**Send role ping panel:**Let's be honest about what doesn't work yet:



```text**Missing Features:**

/sendrolepingembed- No bench/leave buttons in UI (backend supports it, just not exposed)

```- Can't view who joined a run except by looking at the counter

- No `/runhistory` command to browse past runs

Members can toggle which dungeon types they want to be pinged for.- Auto-end duration is hardcoded at 2 hours

- No voice channel integration

---- Tested mostly in one server - multi-guild edge cases might exist



## Project Structure**Bugs:**

- If you're missing env vars, bot crashes with cryptic errors instead of telling you what's wrong

```text- Race condition if two organizers click "End" at the same time

rotmg-raid-bot/- Bot can't manage roles higher than its own role (Discord limitation, but error message could be better)

├── backend/                    # Fastify REST API- Quota reset doesn't happen automatically - you have to click "Reset Panel" manually

│   ├── src/

│   │   ├── server.ts          # Main server entry**Performance:**

│   │   ├── db/- No caching layer - every permission check hits the database

│   │   │   ├── pool.ts        # PostgreSQL connection- No rate limiting on the backend API

│   │   │   └── migrations/    # 46+ schema migrations- Quota leaderboards fetch all members then filter (works fine for <100 people)

│   │   ├── lib/               # Auth, logging, quota logic

│   │   ├── routes/            # API endpoints**Things that could break:**

│   │   │   ├── runs.ts        # Run CRUD operations- If a channel gets deleted while a run is active, the run orphans in the database

│   │   │   ├── raiders.ts     # Verification endpoints- Database migrations have no rollback scripts

│   │   │   ├── punishments.ts # Moderation endpoints- If Discord goes down during auto-end tasks, they'll retry on next run but there might be delays

│   │   │   ├── quota.ts       # Quota tracking

│   │   │   └── guilds.ts      # Configuration endpointsThese are all fixable, just haven't gotten to them yet.

│   │   └── plugins/           # API key authentication

│   └── Dockerfile.dev---

│

├── bot/                        # Discord.js Bot---

│   ├── src/

│   │   ├── index.ts           # Bot initialization## Troubleshooting

│   │   ├── register-commands.ts # Command registration

│   │   ├── commands/          # Slash commands**Bot doesn't respond to commands**

│   │   │   ├── organizer/     # Run, headcount, logrun, logkey, taken- Check logs: `docker-compose logs bot | grep "Successfully registered"`

│   │   │   ├── moderation/    # Verify, warn, suspend, ban, etc.- Verify bot has Send Messages, Embed Links, Manage Roles permissions

│   │   │   └── configs/       # setroles, setchannels, configquota, etc.- Run `/setroles` to configure at least organizer and verified_raider roles

│   │   ├── interactions/      # Button handlers

│   │   │   └── buttons/**"NOT_ORGANIZER" error**

│   │   │       ├── raids/     # Join, class selection, organizer panel- You need the Organizer role configured in `/setroles`

│   │   │       ├── config/    # Quota/points configuration- Make sure you actually have that Discord role

│   │   │       └── verification/ # Verification approval/denial- Bot must be able to see your roles

│   │   ├── constants/         # Dungeon data, classes, emojis

│   │   ├── lib/               # HTTP client, permissions, logging**Backend connection errors**

│   │   ├── services/          # RealmEye integration- Check `BACKEND_URL` in bot/.env matches where backend is running

│   │   └── types/             # TypeScript types- Verify `BACKEND_API_KEY` is identical in both .env files

│   └── Dockerfile.dev- If using Docker: `docker-compose logs` to check both services

│

└── docker-compose.yml          # Orchestration (db, backend, bot)**Database migrations fail**

```- Check PostgreSQL is running and accessible

- Verify `DATABASE_URL` format: `postgres://user:pass@host:port/database`

---- Look at `backend/src/db/migrations/` to see which one failed

- You might need to manually fix the schema and re-run

## Command Reference

**Verification not working**

### General Commands- Set channels: `/setchannels getverified:#your-channel`

- For RealmEye: check if realmeye.com is accessible (sometimes it's down)

| Command | Description | Required Role |- For manual: ensure manual_verification channel is configured

|---------|-------------|---------------|- Bot needs permission to send DMs (users must allow server DMs)

| `/ping` | Check bot latency | Verified Raider |

| `/help [command]` | View all commands or detailed help | Organizer |**Quota panels not updating**

| `/stats [member]` | View quota and point statistics | Verified Raider |- Verify quota channel set: `/setchannels quota:#your-channel`

| `/leaderboard` | View server leaderboards | Verified Raider |- Bot needs send/edit message permissions in that channel

- Role in `/configquota` must exist and have members

### Organizer Commands- Try completing a run to trigger an update



| Command | Description | Required Role |**Role management fails (403 errors)**

|---------|-------------|---------------|- Bot's role must be higher than roles it manages

| `/run` | Create a new raid run | Organizer |- Check Server Settings > Roles for hierarchy

| `/headcount` | Create interest check for multiple dungeons | Organizer |- Bot needs "Manage Roles" permission

| `/taken` | Submit Oryx 3 completion screenshot | Organizer |- Can't manage Discord owners/admins (platform limitation)

| `/logrun` | Manually log run completion | Organizer |

| `/logkey` | Manually log key pops | Organizer |---



### Moderation Commands## Contributing



| Command | Description | Required Role |Want to help? Here's how:

|---------|-------------|---------------|

| `/verify` | Manually verify a member | Security |**Getting Started**

| `/unverify` | Remove verification | Security |1. Fork the repo

| `/editname` | Update verified IGN | Security |2. Set up dev environment (see [Installation](#getting-started))

| `/addalt` | Add alternate IGN | Security |3. Pick something from [Known Issues](#known-issues) or add your own feature

| `/removealt` | Remove alternate IGN | Security |4. Test thoroughly before submitting

| `/warn` | Issue warning | Security |

| `/suspend` | Suspend member (timed) | Security |**Code Style**

| `/unsuspend` | Remove suspension early | Officer |- TypeScript everywhere

| `/mute` | Mute member (timed) | Security |- Add JSDoc for complex functions

| `/unmute` | Remove mute early | Security |- Use Zod for validation

| `/kick` | Kick member from server | Security |- Keep functions focused

| `/ban` | Ban member from server | Security |

| `/unban` | Unban user | Security |**Testing**

| `/softban` | Ban then unban (message cleanup) | Security |No automated tests yet (would love help with this). Test manually:

| `/checkpunishments` | View punishment history | Security |- Create runs and click buttons

| `/removepunishment` | Remove punishment by ID | Officer |- Test with different roles

| `/addnote` | Add staff note | Security |- Try edge cases (missing config, invalid input)

| `/addpoints` | Manually adjust raider points | Officer |- Check database state after operations

| `/addquotapoints` | Manually adjust quota points | Officer |

| `/addrole` | Promote member to staff | Officer |**Pull Requests**

| `/syncteam` | Sync team role for all staff | Administrator |- Clear description of what it does

| `/purge` | Bulk delete messages | Moderator |- Reference related issues

- Make sure bot starts and basic commands work

### Configuration Commands- Update README if adding features



| Command | Description | Required Role |**Areas That Need Help**

|---------|-------------|---------------|- Unit/integration tests

| `/setroles` | Configure role mappings | Moderator |- Environment variable validation on startup

| `/setchannels` | Configure channel mappings | Moderator |- Bench/leave buttons in UI

| `/configquota` | Configure quota settings | Moderator |- Run history command

| `/configpoints` | Configure raider points | Moderator |- Voice channel integration

| `/configverification` | Send verification panel | Moderator |- Redis caching layer

| `/configrolepings` | Configure role pings | Moderator |- Better error messages

| `/sendrolepingembed` | Send role ping panel | Administrator |

---

### Modmail Commands

## Tech Stack

| Command | Description | Required Role |

|---------|-------------|---------------|| Component | Technology | Why |

| `/modmail` | Send message to staff | Verified Raider ||-----------|-----------|-----|

| `/modmailreply` | Reply to modmail ticket | Security || Bot | Discord.js 14 | Best Discord library for Node.js |

| `/modmailblacklist` | Block user from modmail | Moderator || Backend | Fastify | Fast, low overhead, great TS support |

| `/modmailunblacklist` | Unblock user from modmail | Moderator || Database | PostgreSQL 14 | Reliable, handles relational data well |

| Language | TypeScript | Type safety catches bugs early |

---| Runtime | Node.js 18+ | Modern JS features, stable LTS |

| Validation | Zod | Runtime type checking |

## Troubleshooting| Deploy | Docker Compose | Consistent dev/prod environments |



### Bot Not Responding to Commands---



**Causes & Solutions:**## Recent Updates (v0.3.0)



- Verify commands are registered: Check `docker-compose logs bot` for "Successfully registered"**Manual Verification**

- Ensure bot has proper permissions: Send Messages, Embed Links, Manage Roles- Dual verification: RealmEye or screenshot upload

- Configure roles: Run `/setroles` to map at least organizer and verified_raider- Ticket system for Security+ approval

- Custom instructions per guild

### Permission Errors (NOT_ORGANIZER, etc.)- DM notifications for status updates



**Causes & Solutions:****Decimal Points**

- Award fractional points (0.5, 1.25, etc.)

- User lacks required role configured in `/setroles`- Works for quota, raider, and key pop points

- Bot cannot see user's roles (permission issue)- Backward compatible with integers

- Role hierarchy: Bot's role must be higher than roles it manages

**Bot Log Channel**

### Backend Connection Errors- New channel type for general bot activity

- Optional command execution logging

**Causes & Solutions:**- Configurable via `/setchannels`



- Check `BACKEND_URL` in `bot/.env` matches backend location**Previous (v0.2.0)**

- Verify `BACKEND_API_KEY` matches in both `.env` files- Headcount system (multi-dungeon interest checks)

- If using Docker: Ensure services can communicate (`docker-compose logs`)- Command execution logging for analytics

- Raid thread management

### Database Issues- RealmEye verification flow

- Raider points system

**Causes & Solutions:**- Key pop tracking

- Staff notes system

- Verify PostgreSQL is running and accessible

- Check `DATABASE_URL` format: `postgres://user:pass@host:port/database`---

- Migration failures: Check which migration failed and fix schema manually

- For fresh start: Drop database and re-run `npm run migrate`## License



### Verification Not WorkingNot specified. If open-sourcing, consider MIT.



**Causes & Solutions:**---



- Configure channels: `/setchannels getverified:#channel manual_verification:#channel`## Acknowledgments

- RealmEye down: Check if realmeye.com is accessible

- DM permissions: Users must allow DMs from server membersBuilt for the ROTMG community by people who got tired of managing runs in spreadsheets.

- Manual tickets: Ensure manual_verification channel is set and bot has permissions

Thanks to Discord.js and Fastify teams for excellent libraries.

### Quota Panels Not Updating

---

**Causes & Solutions:**

**Last Updated:** November 15, 2025  

- Set quota channel: `/setchannels quota:#channel`**Version:** 0.3.0  

- Check bot has Send Messages and Embed Links permissions in quota channel**Status:** Production ready

- Verify role in `/configquota` exists and has members

- Trigger update by completing a run or logging quota manuallyNeed help? Open an issue with:

- What you tried to do

---- What happened instead

- Relevant error messages

## Technology Stack- Your setup (Docker/manual, OS)



| Component | Technology | Version | Purpose |The quota system tracks and rewards organizer and verifier activity, providing leaderboards and progress tracking.

|-----------|-----------|---------|---------|

| Bot | Discord.js | 14.16.3 | Discord bot framework |### How It Works

| Backend | Fastify | 4.28.1 | REST API server |

| Database | PostgreSQL | 14+ | Data persistence |**Points vs Quota Points:**

| Language | TypeScript | 5.6.3 | Type-safe development |

| Runtime | Node.js | 18+ | Execution environment |- **quota_points**: For organizers (organizing runs) and verifiers (verifying members) - currently active

| Validation | Zod | 3.23.8 | Schema validation |- **points**: For raiders (completing runs, popping keys) - fully implemented with raider points config and key pop tracking

| Logging | Pino | Latest | Structured logging |

| Deployment | Docker Compose | 3.9 | Container orchestration |**Automatic Tracking:**



---- When a run is ended (via "End" button or auto-end), a quota event is automatically logged

- When a member is verified (manual `/verify` or automated RealmEye verification), a quota event is automatically logged

## Maintenance- When keys are logged via `/logkey`, key pop points are tracked and awarded based on configuration

- Points are awarded based on dungeon type and role-specific overrides

### Database Backups

**Configurable Point Values:**

Regular backups are essential. Use `pg_dump` for PostgreSQL backups:

- Default: 1 point per run completed, 1 point per verification

```bash- Per-dungeon overrides: Set custom point values (e.g., Shatters = 3 points, Fungal = 2 points)

docker-compose exec db pg_dump -U postgres rotmg_raids > backup_$(date +%Y%m%d).sql- Per-role configuration: Different roles can have different point values for the same dungeon

```

**Quota Periods:**

### Log Management

- Configured with absolute datetime resets (e.g., "Resets on December 1, 2025 at 00:00 UTC")

Logs are written to stdout/stderr. Configure log rotation in production:- `created_at` tracks when the current quota period started

- `reset_at` defines when the next reset occurs

```bash- After reset, manually update `reset_at` to the next period and `created_at` to NOW

docker-compose logs --tail=1000 bot > bot_logs.txt

docker-compose logs --tail=1000 backend > backend_logs.txt**Leaderboard Panels:**

```

- Auto-updating embeds posted in the quota channel

### Monitoring- Show top 25 members with quota points

- Display who has met quota (✅) and who hasn't

Monitor these key metrics:- Include rank indicators (🥇🥈🥉)

- Update in real-time when runs end or verifications occur

- Database connection pool usage

- API response times### Configuration Workflow

- Command execution success rate

- Scheduled task completion1. **Set up role**: `/configquota role:@Raid Leader`

- Error rates by type2. **Configure basics**: Click "Set Basic Config" button

   - Set required points (e.g., 10 points to meet quota)

### Updates   - Set reset datetime (e.g., 2025-12-01T00:00:00Z)

3. **Set dungeon overrides**: Click "Configure Dungeons" button

To update the bot:   - Select dungeon from dropdown

   - Enter point value (e.g., 3 for Shatters)

1. Pull latest changes: `git pull origin main`4. **Create panel**: Click "Update Panel" button

2. Rebuild containers: `docker-compose build`   - Bot posts leaderboard in quota channel

3. Restart services: `docker-compose up -d`   - Panel auto-updates when quota events occur

4. Check logs: `docker-compose logs -f bot backend`5. **Reset quota**: Click "Reset Panel" button when period ends

   - Updates `created_at` to NOW (start new period)

---   - Keeps same `reset_at` until you update it



## Support & Documentation### Manual Quota Management



- **Internal Docs**: See `bot/src/services/realmeye/README.md` and `backend/test/README.md`**Manually log runs** (for retroactive tracking or corrections):

- **Issue Reporting**: Include error messages, setup details, and steps to reproduce

- **Version**: Check version with `/ping` command or in this README```text

/logrun dungeon:Shatters amount:1

**Last Updated:** November 17, 2025  /logrun dungeon:Fungal amount:-1  # Remove 1 point

**Status:** Production Ready```


**Manually log key pops** (track raider key contributions):

```text
/logkey member:@Raider dungeon:Shatters amount:1
/logkey member:@Raider dungeon:Fungal amount:-1  # Remove 1 key
```

**Manually adjust points** (for corrections or special awards):

```text
/addpoints member:@Raider amount:5       # Add raider points
/addquotapoints member:@Officer amount:3  # Add quota points
```

**View statistics**:

```text
/stats                    # Your own stats
/stats member:@OtherUser  # Someone else's stats
```

**Sync team role** (after adding new staff):

```text
/syncteam  # Auto-assigns Team role to all members with staff roles
```

---

## 📂 Complete File Tree

```
rotmg-raid-bot/
├── README.md                          # This comprehensive documentation
├── docker-compose.yml                 # Docker orchestration (db, backend, bot)
│
├── backend/                           # Fastify REST API
│   ├── Dockerfile.dev                 # Development Docker image
│   ├── package.json                   # Backend dependencies
│   ├── tsconfig.json                  # TypeScript configuration
│   └── src/
│       ├── server.ts                  # Main Fastify server entrypoint
│       ├── config.ts                  # Configuration loader and validation
│       │
│       ├── db/
│       │   ├── pool.ts                # PostgreSQL connection pool
│       │   └── migrations/            # Database schema migrations
│       │       ├── 001_init.sql       # Initial schema (guilds, members, raiders, runs, reactions, audit)
│       │       ├── 002_contract_safety.sql  # Data integrity constraints & indexes
│       │       ├── 003_remove_cap.sql       # Remove raider cap
│       │       ├── 004_add_party_location.sql # Add party/location fields
│       │       ├── 005_key_window.sql       # Add key window timing
│       │       ├── 006_update_status_constraint.sql # Add 'live' status
│       │       ├── 007_add_raider_ign.sql   # Add IGN field to raiders
│       │       ├── 008_guild_roles.sql      # Guild role mappings
│       │       ├── 009_guild_channels.sql   # Guild channel mappings
│       │       ├── 010_punishments.sql      # Punishment system (warns/suspensions)
│       │       ├── 011_migrate_punishment_ids.sql # Migrate old punishment IDs to hex
│       │       ├── 012_auto_end_duration.sql # Add auto-end timing for runs
│       │       ├── 013_nullable_audit_actor.sql # Make audit actor nullable
│       │       ├── 014_quota_events.sql     # Quota event tracking system
│       │       ├── 015_team_role.sql        # Team role for staff members
│       │       ├── 016_quota_config.sql     # Quota configuration per role
│       │       ├── 017_add_quota_channel.sql # Quota channel catalog entry
│       │       ├── 018_quota_reset_datetime.sql # Quota reset scheduling
│       │       ├── 019_add_quota_created_at.sql # Quota period tracking
│       │       ├── 020_separate_points_quota_points.sql # Separate raider/organizer points
│       │       ├── 021_raider_points_config.sql # Raider points configuration
│       │       ├── 022_key_reactions.sql    # Key reactions for dungeons
│       │       ├── 023_key_pops_tracking.sql # Track key pops per user/dungeon
│       │       ├── 024_key_pop_points_config.sql # Points for key pops
│       │       ├── 025_notes.sql            # Staff notes system
│       │       ├── 026_verification_sessions.sql # RealmEye verification flow
│       │       ├── 027_command_log.sql      # Command execution logging
│       │       ├── 028_decimal_quota_points.sql # Decimal point support (0.5, 1.25, etc.)
│       │       ├── 029_manual_verification.sql # Manual verification system with tickets
│       │       └── 030_bot_log_channel.sql  # Bot log channel mapping
│       │
│       ├── lib/
│       │   ├── authorization.ts       # ✅ Role-based authorization checks
│       │   ├── audit.ts               # ✅ Audit logging helper
│       │   ├── constants.ts           # ✅ Shared types & Zod schemas (RunStatus, ReactionState, Snowflake)
│       │   ├── database-helpers.ts    # ✅ Database utility functions
│       │   ├── errors.ts              # ✅ Unified error response helpers
│       │   ├── logger.ts              # ✅ Structured logging utilities
│       │   ├── permissions.ts         # ✅ Permission checking utilities
│       │   └── quota.ts               # ✅ Quota system logic & database queries
│       │
│       ├── plugins/
│       │   └── auth.ts                # ✅ API key authentication middleware
│       │
│       ├── routes/
│       │   ├── health.ts              # ✅ Public health check endpoint
│       │   ├── runs.ts                # ✅ CRUD for runs & reactions (create, join, class, status, delete)
│       │   ├── guilds.ts              # ✅ Guild role/channel configuration
│       │   ├── punishments.ts         # ✅ Warning & suspension management
│       │   ├── raiders.ts             # ✅ Raider verification & IGN management
│       │   ├── notes.ts               # ✅ Staff notes system
│       │   ├── verification.ts        # ✅ RealmEye verification sessions
│       │   ├── quota.ts               # ✅ Quota tracking, configuration, and leaderboards
│       │   └── command-log.ts         # ✅ Command execution logging
│       │
│       └── scripts/
│           └── migrate.ts             # ✅ Database migration runner
│
└── bot/                               # Discord.js Bot
    ├── Dockerfile.dev                 # Development Docker image
    ├── package.json                   # Bot dependencies
    ├── tsconfig.json                  # TypeScript configuration
    └── src/
        ├── index.ts                   # ✅ Bot client initialization & event handlers
        ├── register-commands.ts       # ✅ Registers slash commands to Discord API
        ├── config.ts                  # ✅ Configuration loader and validation
        │
        ├── commands/                  # Slash commands
        │   ├── _types.ts              # TypeScript types for slash commands
        │   ├── index.ts               # Command registry & registration helper
        │   ├── ping.ts                # ✅ Simple latency test command
        │   ├── help.ts                # ✅ Display all available commands with filtering
        │   ├── run.ts                 # ✅ Create raid with dungeon autocomplete
        │   ├── headcount.ts           # ✅ Create lightweight headcount panels for gauging interest
        │   ├── logrun.ts              # ✅ Manually log run completion for quota
        │   ├── logkey.ts              # ✅ Manually log key pops for raider
        │   ├── stats.ts               # ✅ View quota statistics for users
        │   ├── syncteam.ts            # ✅ Sync Team role for all members (Admin only)
        │   ├── conifgs/               # Configuration commands
        │   │   ├── setroles.ts        # ✅ Configure guild role mappings (Moderator+ only)
        │   │   ├── setchannels.ts     # ✅ Configure guild channel mappings (Moderator+ only)
        │   │   ├── configquota.ts     # ✅ Configure quota settings per role (Moderator+ only)
        │   │   ├── configpoints.ts    # ✅ Configure raider points per dungeon (Moderator+ only)
        │   │   └── configverification.ts # ✅ Send RealmEye verification panel (Moderator+ only)
        │   └── moderation/            # Moderation commands
        │       ├── verify.ts          # ✅ Manually verify members (Security role)
        │       ├── unverify.ts        # ✅ Remove verification from members
        │       ├── editname.ts        # ✅ Update verified member's IGN
        │       ├── warn.ts            # ✅ Issue warnings (Security role)
        │       ├── suspend.ts         # ✅ Suspend members with duration (Security role)
        │       ├── unsuspend.ts       # ✅ Remove suspensions early (Officer role)
        │       ├── removepunishment.ts # ✅ Remove any punishment by ID (Officer role)
        │       ├── checkpunishments.ts # ✅ View all punishments for a user (Security role)
        │       ├── addnote.ts         # ✅ Add staff note to member (Security role)
        │       ├── addpoints.ts       # ✅ Manually adjust raider points (Officer role)
        │       └── addquotapoints.ts  # ✅ Manually adjust quota points (Officer role)
        │
        ├── constants/                 # Dungeon data & game constants
        │   ├── classes.ts             # ✅ ROTMG character classes
        │   ├── dungeon-types.ts       # ✅ TypeScript interfaces for dungeon data
        │   ├── dungeon-helpers.ts     # ✅ Search & lookup utilities for dungeons
        │   ├── DungeonData.ts         # ✅ 50+ ROTMG dungeon definitions (portals, emojis, colors)
        │   ├── EmojiConstants.ts      # ✅ Discord emoji definitions and mappings
        │   ├── MappedAfkCheckReactions.ts # ✅ Afk check reaction mappings
        │   └── index.ts               # ✅ Barrel exports for constants
        │
        ├── interactions/              # Button & select menu handlers
        │   └── buttons/
        │       ├── config/            # Configuration button handlers
        │       │   ├── quota-config.ts         # ✅ Quota configuration modals and selects
        │       │   ├── points-config.ts        # ✅ Raider points configuration
        │       │   └── key-pop-points-config.ts # ✅ Key pop points configuration
        │       ├── raids/             # Raid interaction handlers
        │       │   ├── join.ts                 # ✅ Handle "Join" button → post reaction to backend
        │       │   ├── class-selection.ts      # ✅ Handle class selection UI & backend update
        │       │   ├── key-window.ts           # ✅ Handle "Pop Keys" button during live runs
        │       │   ├── key-reaction.ts         # ✅ Handle key emoji reactions
        │       │   ├── organizer-panel.ts      # ✅ Show organizer-only controls (Start/End/Pop Keys/Cancel)
        │       │   ├── run-status.ts           # ✅ Handle Start/End buttons → update backend & UI
        │       │   ├── party-location.ts       # ✅ Handle party/location update buttons
        │       │   ├── headcount-join.ts       # ✅ Handle headcount join interactions
        │       │   ├── headcount-key.ts        # ✅ Handle headcount key offering
        │       │   ├── headcount-organizer-panel.ts # ✅ Headcount organizer controls
        │       │   ├── headcount-convert.ts    # ✅ Convert headcount to run
        │       │   └── headcount-end.ts        # ✅ End/delete headcount
        │       └── verification/      # Verification button handlers
        │           ├── get-verified.ts         # ✅ RealmEye & manual verification flow initiation
        │           └── approve-deny.ts         # ✅ Manual verification ticket review (Security+)
        │
        ├── services/                  # External service integrations
        │   └── realmeye/
        │       ├── http.ts            # ✅ HTTP client for RealmEye API
        │       ├── player.ts          # ✅ Player data fetching and parsing
        │       ├── index.ts           # ✅ Service exports
        │       └── README.md          # Documentation for RealmEye service
        │
        ├── scripts/
        │   └── test-realmeye.ts       # ✅ Testing script for RealmEye integration
        │
        ├── types/
        │   └── reactions.ts           # ✅ Type definitions for reactions
        │
        └── lib/                       # Shared utilities
            ├── http.ts                # ✅ Backend HTTP client with unified error handling
            ├── logger.ts              # ✅ Structured logging utilities
            ├── command-logging.ts     # ✅ Command execution logging utilities
            ├── raid-logger.ts         # ✅ Centralized raid logging with thread management
            ├── permissions/           # Permission utilities
            │   ├── permissions.ts          # ✅ Role hierarchy & permission checks
            │   ├── interaction-permissions.ts # ✅ Interaction-specific permission helpers
            │   └── command-middleware.ts   # ✅ Command permission middleware
            ├── pagination.ts          # ✅ Paginated embed builder for long lists
            ├── dungeon-cache.ts       # ✅ Track recently used dungeons per guild
            ├── dungeon-autocomplete.ts # ✅ Dungeon autocomplete handler
            ├── scheduled-tasks.ts     # ✅ Unified scheduler for all auto-checks (runs, suspensions, verification)
            ├── quota-panel.ts         # ✅ Quota leaderboard panel management
            ├── configpoints-panel.ts  # ✅ Raider points configuration panel
            ├── team-role-manager.ts   # ✅ Automatic Team role assignment for staff
            ├── verification.ts        # ✅ RealmEye verification flow helpers
            ├── headcount-state.ts     # ✅ Headcount state management utilities
            ├── key-emoji-helpers.ts   # ✅ Key emoji handling utilities
            ├── embed-builders.ts      # ✅ Common embed building utilities
            ├── interaction-helpers.ts # ✅ Common interaction utilities
            └── error-handler.ts       # ✅ Unified error formatting
```

---

## 🎯 What We Currently Have

### Backend API (Fastify)

#### **Database Schema**

- ✅ **guild**: Guild metadata (id, name)
- ✅ **member**: User metadata (id, username)
- ✅ **raider**: Verified raiders with IGN and status (pending/approved/rejected/banned)
- ✅ **run**: Active raids with organizer, dungeon, status (open/live/ended), timestamps, auto-end duration
- ✅ **reaction**: User participation (join/bench/leave) with optional class selection
- ✅ **audit**: Comprehensive audit log for all actions (guild config, verifications, punishments)
- ✅ **guild_role**: Maps internal role keys (organizer, security, moderator, team, etc.) to Discord role IDs
- ✅ **guild_channel**: Maps internal channel keys (raid, veri_log, punishment_log, quota, getverified, raid_log, etc.) to Discord channel IDs
- ✅ **punishment**: Warning & suspension tracking with expiration, removal tracking, and status
- ✅ **note**: Staff notes system for silent warnings/notes on members
- ✅ **quota_event**: Tracks organizer/verifier actions (runs completed, verifications) with points and timestamps
- ✅ **quota_role_config**: Per-role quota configuration (required points, reset schedule, leaderboard panel)
- ✅ **quota_dungeon_override**: Custom point values per dungeon per role
- ✅ **raider_points_config**: Guild-wide raider points configuration per dungeon
- ✅ **key_pop**: Track keys popped per dungeon by each user
- ✅ **key_pop_points_config**: Points awarded for popping keys per dungeon
- ✅ **verification_session**: RealmEye verification flow state (pending_ign, pending_realmeye, verified, cancelled, expired)
- ✅ **command_log**: Logs all slash command executions for analytics, debugging, and auditing

#### **API Endpoints**

**Health & Info**
- `GET /v1/health` - Public health check

**Runs**
- `POST /v1/runs` - Create new run (organizer role required)
- `GET /v1/runs/:id` - Get run details
- `PATCH /v1/runs/:id` - Update run status (open→live→ended)
- `DELETE /v1/runs/:id` - Cancel/delete run (organizer only)
- `POST /v1/runs/:id/message` - Link Discord message ID to run
- `POST /v1/runs/:id/reactions` - Add/update/remove reaction (join/bench/leave)
- `PATCH /v1/runs/:id/reactions` - Update class selection
- `GET /v1/runs/:id/classes` - Get class distribution for run
- `PATCH /v1/runs/:id/key-window` - Open key window with countdown
- `GET /v1/runs/expired` - Get runs that need auto-ending

**Raiders (Verification)**
- `GET /v1/raiders/:guild_id/:user_id` - Get raider info
- `POST /v1/raiders/verify` - Verify member with IGN (security role required)
- `PATCH /v1/raiders/:user_id/ign` - Update verified member's IGN (security role required)
- `PATCH /v1/raiders/:user_id/status` - Update raider status (security role required)

**Punishments**
- `POST /v1/punishments` - Create warning or suspension (moderator role required)
- `GET /v1/punishments/:id` - Get punishment details
- `GET /v1/punishments/user/:guild_id/:user_id` - Get all punishments for user
- `GET /v1/punishments/expired` - Get expired suspensions needing role removal
- `POST /v1/punishments/:id/expire` - Mark suspension as expired (processed by bot)
- `DELETE /v1/punishments/:id` - Remove/deactivate punishment (moderator role required)

**Guild Configuration**

- `GET /v1/guilds/:guild_id/roles` - Get current role mappings
- `PUT /v1/guilds/:guild_id/roles` - Update role mappings (admin role or Discord admin required)
- `GET /v1/guilds/:guild_id/channels` - Get current channel mappings
- `PUT /v1/guilds/:guild_id/channels` - Update channel mappings (admin role or Discord admin required)

**Quota System**

- `POST /v1/quota/log-run` - Manually log run completion for quota (organizer role required)
- `POST /v1/quota/log-key` - Manually log key pops for quota/points (organizer role required)
- `POST /v1/quota/adjust-points` - Manually adjust raider points (officer role required)
- `POST /v1/quota/adjust-quota-points` - Manually adjust quota points (officer role required)
- `GET /v1/quota/stats/:guild_id/:user_id` - Get quota statistics for a user
- `GET /v1/quota/config/:guild_id/:role_id` - Get quota configuration for a role
- `GET /v1/quota/configs/:guild_id` - Get all quota configurations for a guild
- `PUT /v1/quota/config/:guild_id/:role_id` - Update quota configuration (moderator required)
- `PUT /v1/quota/config/:guild_id/:role_id/dungeon/:dungeon_key` - Set dungeon point override
- `DELETE /v1/quota/config/:guild_id/:role_id/dungeon/:dungeon_key` - Remove dungeon override
- `POST /v1/quota/leaderboard/:guild_id/:role_id` - Get quota leaderboard for a role
- `GET /v1/quota/raider-points/:guild_id` - Get raider points configuration
- `PUT /v1/quota/raider-points/:guild_id/:dungeon_key` - Set raider points for dungeon
- `DELETE /v1/quota/raider-points/:guild_id/:dungeon_key` - Remove raider points config

**Notes System**

- `POST /v1/notes` - Create a new note for a user (security role required)
- `GET /v1/notes/:id` - Get a specific note by ID
- `GET /v1/notes/user/:guild_id/:user_id` - Get all notes for a user in a guild

**Verification System**

- `GET /v1/verification/session/user/:user_id` - Get active verification session for user (any guild)
- `GET /v1/verification/session/:guild_id/:user_id` - Get verification session for user in guild
- `POST /v1/verification/session` - Create new verification session
- `PATCH /v1/verification/session/:guild_id/:user_id` - Update verification session
- `DELETE /v1/verification/session/:guild_id/:user_id` - Delete verification session
- `POST /v1/verification/cleanup-expired` - Cleanup expired sessions (bot cron job)

**Command Logging**

- `POST /v1/command-log` - Log a slash command execution (internal bot use)
  - Tracks command usage, success/failure, latency, and options
  - Used for analytics, debugging, and auditing

#### **Authorization System**

- ✅ Role-based permissions using guild_role mappings
- ✅ Internal roles: administrator, moderator, head_organizer, officer, security, organizer, verified_raider, suspended, team
- ✅ Hierarchical authorization checks
- ✅ Supports Discord Administrator permission override for guild config

### Bot (Discord.js)

#### **Slash Commands**

**General**
- ✅ `/ping` - Check bot latency
- ✅ `/help [category]` - Display all available commands with optional category filtering

**Raid Management**
- ✅ `/run` - Create new raid with dungeon autocomplete
  - Shows recently used dungeons when no search query
  - Party/location optional parameters
  - Description field for organizer notes
  - Auto-end after 2 hours (configurable in code)
- ✅ `/headcount` - Create lightweight headcount panel to gauge interest
  - Select up to 10 dungeons for a single headcount
  - Users can join and offer keys for specific dungeons
  - Organizer can convert headcount to run or end it
  - Automatically creates threads in raid-log channel for organization
- ✅ `/logrun [dungeon] [amount]` - Manually log run completion for quota
  - Award or remove quota points (supports negative amounts)
  - Can specify dungeon or use most recent run
- ✅ `/logkey <member> <dungeon> [amount]` - Log key pops for raider
  - Track raider key contributions
  - Award key pop points based on configuration
  - Supports negative amounts to remove keys

**Verification System** (Security role required)
- ✅ `/verify` - Manually verify member with their ROTMG IGN
  - Checks for IGN conflicts (one IGN per member)
  - Sets member nickname to IGN
  - Assigns verified_raider role
  - Logs to veri_log channel
  - Role hierarchy checks to prevent abuse
- ✅ `/unverify` - Remove verification status from member
- ✅ `/editname` - Update verified member's IGN
- ✅ `/configverification` - Send verification panel (Moderator+ role)
  - Send interactive verification panel to get-verified channel
  - Supports both RealmEye and manual screenshot verification
  - **RealmEye**: Automated DM flow → verify via RealmEye profile code
  - **Manual Screenshot**: User uploads screenshot → ticket system → Security+ review
  - Configure custom instructions for manual verification
  - Configure custom panel message per guild

**Moderation System**
- ✅ `/warn` - Issue warning to member with reason (Security+ role)
- ✅ `/suspend` - Suspend member with duration (Security+ role)
  - Duration in days/hours/minutes
  - Assigns suspended role automatically
  - Can extend existing suspensions
  - Automatic role removal on expiration
- ✅ `/unsuspend` - Remove active suspension early (Officer+ role)
- ✅ `/removepunishment` - Remove any punishment by ID (Officer+ role)
- ✅ `/checkpunishments` - View all punishments and notes for a user (Security+ role, paginated)
- ✅ `/addnote` - Add staff note to member (Security+ role)
  - Silent warnings/observations visible only to staff
  - Shown in /checkpunishments alongside warnings/suspensions
- ✅ `/addpoints [member] <amount>` - Manually adjust raider points (Officer+ role)
  - Award or deduct points for special circumstances
  - Supports negative amounts
- ✅ `/addquotapoints [member] <amount>` - Manually adjust quota points (Officer+ role)
  - Award or deduct quota points for corrections
  - Supports negative amounts

**Configuration** (Moderator+ role required)

- ✅ `/setroles` - Configure guild role mappings
  - Maps internal roles to Discord roles
  - Required for permission system to work
  - Supports 9 internal roles (including team)
- ✅ `/setchannels` - Configure guild channel mappings
  - Maps internal channels to Discord channels
  - Channels: raid, veri_log, punishment_log, raid_log, quota, getverified, manual_verification, bot_log
  - Used for logging and interactive panels
- ✅ `/configquota <role>` - Configure quota settings for a specific role
  - Set required points per quota period
  - Configure reset schedule (absolute datetime)
  - Set per-dungeon point overrides
  - Manage leaderboard panels
- ✅ `/configpoints` - Configure raider points for dungeons
  - Guild-wide configuration for raider participation points
  - Set how many points raiders earn per dungeon type
  - Interactive panel with dungeon selection
- ✅ `/syncteam` - Sync Team role for all members (Administrator)
  - Auto-assigns Team role to members with staff roles
  - Useful after initial setup or role changes

**Statistics** (Anyone can view)

- ✅ `/stats [member]` - View quota statistics for yourself or another member
  - Shows total points and quota points
  - Runs organized and verifications
  - Keys popped per dungeon
  - Per-dungeon breakdown with counts

#### **Interactive UI**

**Run Embeds**

- ✅ Dynamic embed updates based on run status
- ✅ Raider count display
- ✅ Class distribution display (formatted intelligently)
- ✅ Status indicators (Starting/Live/Ended)
- ✅ Dungeon thumbnails and colors
- ✅ Party and location information

**Headcount Panels**

- ✅ Multi-dungeon selection (up to 10 dungeons)
- ✅ Participant tracking with join button
- ✅ Key offer tracking per dungeon
- ✅ Convert to run functionality
- ✅ Automatic thread creation in raid-log channel
- ✅ Organizer-only controls for management

**Button Interactions**

- ✅ "Join" - Join a run (adds reaction, updates embed)
- ✅ "Class" - Select character class via dropdown menu
- ✅ "Organizer Panel" - Opens ephemeral panel with controls
  - "Start" - Transitions run from open → live
  - "Pop Keys" - Opens 30-second key window
  - "End" - Ends run and removes buttons
  - "Cancel" - Cancels run (marks as cancelled)
- ✅ "Headcount Join" - Join a headcount panel
- ✅ "Offer Key" - Indicate which dungeon keys you can pop
- ✅ "Headcount Organizer Panel" - Opens ephemeral panel with controls
  - "Convert to Run" - Converts headcount to a full run
  - "End Headcount" - Ends and removes headcount panel

**Permission Checks**
- ✅ Organizer panel restricted to run organizer or users with organizer role
- ✅ Role hierarchy enforcement (can't target someone with equal/higher role)
- ✅ Bot role position checks (can't manage users above bot's role)

#### **Automated Tasks**

**Run Auto-End** (runs every 5 minutes)
- ✅ Checks for runs exceeding auto_end_minutes
- ✅ Automatically ends expired runs
- ✅ Updates Discord embeds to show auto-ended status
- ✅ Removes interaction buttons

**Suspension Cleanup** (runs every 1 minute)
- ✅ Checks for expired suspensions
- ✅ Removes suspended role automatically
- ✅ Logs expiration to punishment_log channel
- ✅ Marks suspensions as processed in database

**Verification Session Cleanup** (runs every 5 minutes)
- ✅ Checks for expired verification sessions
- ✅ Marks sessions as expired after 1 hour timeout
- ✅ Prevents orphaned sessions from accumulating

#### **Advanced Features**

**Dungeon Autocomplete**
- ✅ Fuzzy search across 50+ ROTMG dungeons
- ✅ Shows recently used dungeons for the guild when search is empty
- ✅ Intelligent caching per guild

**Audit Logging**
- ✅ All actions logged to database with actor, action, subject, and metadata
- ✅ Discord channel logging for verifications and punishments
- ✅ Tracks before/after state for config changes

**Error Handling**

- ✅ User-friendly error messages with actionable guidance
- ✅ Explains missing role configurations
- ✅ Handles IGN conflicts gracefully
- ✅ Graceful degradation when optional features fail

**Quota Tracking & Leaderboards**

- ✅ Track organizer activity (runs organized per dungeon)
- ✅ Track verifier activity (members verified)
- ✅ Track raider activity (keys popped per dungeon)
- ✅ Configurable point values per dungeon per role
- ✅ Automatic leaderboard panels that update in real-time
- ✅ Quota period management with absolute datetime resets
- ✅ Manual quota adjustment (add/remove points)
- ✅ Separate points system for raider participation tracking (fully implemented)
- ✅ Key pop tracking with configurable point rewards

**Team Role Management**

- ✅ Automatically assigns Team role to members with any staff role
- ✅ Listens to role changes via GuildMemberUpdate event
- ✅ Automatically removes Team role when staff roles are removed
- ✅ Manual sync command for bulk updates
- ✅ Configurable Team role via guild role mappings

**RealmEye Verification System**

- ✅ Automated verification flow via DMs
- ✅ Interactive "Get Verified" button in configured channel
- ✅ Two verification methods:
  - **RealmEye**: Multi-step flow → IGN → RealmEye code → automatic verification
  - **Manual Screenshot**: User uploads vault screenshot with Discord tag → ticket system for Security+ review
- ✅ Session management with 1-hour timeout
- ✅ Automatic role assignment and nickname setting
- ✅ IGN conflict detection and validation
- ✅ Manual verification override via `/verify` command
- ✅ Configurable channels via `/setchannels` (getverified, manual_verification)
- ✅ Custom instructions for manual verification per guild
- ✅ Ticket-based review system with approve/deny buttons (Security+ only)
- ✅ Denial reasons tracked and communicated to users
- ✅ Full audit trail for all verification attempts

**Staff Notes System**

- ✅ Silent notes visible only to staff (Security+)
- ✅ Separate from formal punishments
- ✅ Shown alongside warnings/suspensions in `/checkpunishments`
- ✅ Useful for tracking observations and informal warnings
- ✅ Full audit trail with timestamps and moderator info

**Command Execution Logging**

- ✅ Automatic logging of all slash command executions
- ✅ Tracks command name, options, success/failure, and latency
- ✅ Sanitizes sensitive data (tokens, passwords) before storage
- ✅ Used for analytics, debugging, and usage monitoring
- ✅ Indexed for efficient querying by guild, command, user, and error type

**Raid Logging & Thread Management**

- ✅ Centralized raid logging system with dedicated threads
- ✅ Creates organized threads in raid-log channel for each run/headcount
- ✅ Logs all raid events (creation, start, end, key pops, etc.)
- ✅ In-memory caching for thread IDs to improve performance
- ✅ Supports both runs and headcounts with unified interface

**RealmEye Service Integration**

- ✅ HTTP client for fetching player data from RealmEye
- ✅ Player profile parsing and validation
- ✅ Character data extraction and statistics
- ✅ Used for automated verification flow
- ✅ Configurable with retry logic and error handling

---

## ⚙️ Technical Stack

| Component | Technology | Version | Purpose |
|-----------|-----------|---------|---------|
| Bot | Discord.js | ^14.16.3 | Discord bot framework |
| Backend | Fastify | ^4.28.1 | REST API server |
| Database | PostgreSQL | 14+ | Data persistence |
| Language | TypeScript | ^5.6.3 | Type-safe development |
| Runtime | Node.js | 18+ (ES2022) | Execution environment |
| Validation | Zod | ^3.23.8 | Schema validation |
| Containerization | Docker Compose | 3.9 | Development environment |

---

## Getting Started

### Prerequisites

Before you dive in, make sure you have:

- **Node.js 18+** (the bot uses modern JS features)
- **Docker & Docker Compose** (easiest way to run everything)
- **PostgreSQL 14+** (if you're not using Docker)
- **A Discord Bot Token** (create one at [Discord Developer Portal](https://discord.com/developers/applications))

### Installation

**Option 1: Docker Compose (Recommended)**

This is the easiest way. Everything runs in containers, no need to install Postgres or worry about dependencies.

```bash
git clone <your-repo-url>
cd rotmg-raid-bot
```

Create `backend/.env`:

```env
PORT=4000
BACKEND_API_KEY=your_secret_key_here_make_it_long
DATABASE_URL=postgres://postgres:postgres@db:5432/rotmg_raids
```

Create `bot/.env`:

```env
APPLICATION_ID=your_discord_app_id
SECRET_KEY=your_discord_bot_token
DISCORD_DEV_GUILD_ID=your_test_server_id
BACKEND_URL=http://backend:4000/v1
BACKEND_API_KEY=your_secret_key_here_make_it_long
```

**Important**: The `BACKEND_API_KEY` must match in both files. This is how the bot authenticates with the API.

Start everything:

```bash
docker-compose up -d
```

The first startup takes a minute—it installs dependencies, runs migrations, and registers commands. Check the logs:

```bash
docker-compose logs -f bot
```

**Option 2: Manual Setup**

If you prefer running things locally (useful for development):

**Backend:**

```bash
cd backend
npm install
npm run migrate  # Sets up database tables
npm run dev      # Starts with hot reload
```

**Bot:**

```bash
cd bot
npm install
npm run register # Registers slash commands with Discord
npm run dev      # Starts with hot reload
```

Make sure your PostgreSQL is running and the `DATABASE_URL` in `backend/.env` points to it.

### Initial Setup

Once the bot's online, you need to configure it in your Discord server:

**1. Configure Roles** (Required)

Run `/setroles` to map your Discord roles to bot permissions:

```
/setroles
  administrator: @Admin
  moderator: @Moderator  
  security: @Security
  organizer: @Raid Leader
  officer: @Officer
  verified_raider: @Verified
  suspended: @Suspended
  team: @Team
```

At minimum, set up `organizer`, `security`, and `verified_raider`. The bot won't work properly without these.

**2. Configure Channels** (Recommended)

Run `/setchannels` to tell the bot where to log stuff:

```
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

**3. Test It**

Try creating a run:

```
/run dungeon:Shatters
```

If everything's set up correctly, you'll see an embed with buttons. Click "Join" to make sure interactions work.

---

## How to Use

### Creating Runs

The `/run` command is your main tool. It includes autocomplete that remembers what your server runs most often:

```
/run dungeon:Shatters party:Nexus2 location:USEast description:Bring priest pls
```

What happens next:

1. Bot creates a database record
2. Posts an embed in your raid channel with buttons
3. Players click "Join" and select their class
4. You (or someone with Organizer role) click "Organizer Panel" to Start/End the run
5. If you forget to end it, the bot does it automatically after 2 hours

**Headcounts** are lighter-weight—use them to check interest before starting a full run:

```
/headcount
```

Pick up to 10 dungeons from the dropdown. Players can join and indicate which dungeons they have keys for. When you're ready, convert it to a full run or just end it.

### Verification System

There are two ways to verify players:

**RealmEye (Automated):**

1. Set up the verification panel: `/configverification send-panel channel:#get-verified`
2. Players click "Get Verified" → bot DMs them
3. They provide their IGN → bot gives them a code
4. They add the code to their RealmEye profile
5. Bot verifies and assigns the Verified Raider role automatically

**Manual (Screenshot):**

1. Same panel, but players choose "Manual Verification"
2. They upload a screenshot of their vault with their Discord tag visible
3. Creates a ticket in your manual_verification channel
4. Security+ staff review and approve/deny
5. Bot handles role assignment

**Manual Override:**

Security staff can always use `/verify` to manually verify someone:

```
/verify member:@Player ign:TheirRotmgName
```

### Moderation Tools

**Warnings:**

```
/warn member:@Player reason:Rushing ahead and dying
```

**Suspensions:**

```
/suspend member:@Player duration_days:3 reason:Repeated rule violations
```

The bot assigns the Suspended role immediately and removes it automatically when time's up.

**Checking History:**

```
/checkpunishments member:@Player
```

Shows all warnings, suspensions, and staff notes. Pagination works if there's a lot.

**Staff Notes:**

```
/addnote member:@Player note:Keep an eye on this one, been acting sus
```

Notes are private—only Security+ staff can see them.

### Quota System Explained

Quota tracks how active your organizers and verifiers are. It's optional but useful for promoting people or just recognizing top contributors.

**Setup:**

```
/configquota role:@Raid Leader
```

This opens an interactive panel where you:

- Set required points (e.g., "Must complete 10 runs per month")
- Configure reset datetime (absolute time like "2025-12-01T00:00:00Z")
- Override point values per dungeon (Shatters = 3 points, Pirate Cave = 1 point)
- Create a leaderboard panel that updates automatically

**How Points Work:**

- Every time a run ends (via "End" button or auto-end), the organizer gets points
- Every verification adds points to the verifier
- Every key pop can award points (configurable via `/configpoints`)
- Points are calculated based on dungeon type and role-specific overrides

**Manual Adjustments:**

```
/logrun dungeon:Shatters amount:1  # Add quota points
/logkey member:@Raider dungeon:Shatters amount:1  # Log keys popped
/addquotapoints member:@Officer amount:5  # Direct point adjustment
```

**View Stats:**

```
/stats  # Your own stats
/stats member:@OtherPerson  # Someone else's stats
```

---

## File Structure

### Current Limitations

1. **No Bench/Leave Buttons**: UI only shows "Join" button. Backend supports bench/leave states, but not exposed in UI for runs.

2. **No Reaction List Command**: Can't view who joined a run except by counting in the embed.

3. **No Run History**: Past runs aren't queryable via commands (data exists in database).

4. **Single-Guild Testing**: Primarily tested in one server; multi-guild scenarios may have edge cases.

5. **No Voice Integration**: No automated voice channel creation or management.

6. **Fixed Auto-End Duration**: 2-hour auto-end is hardcoded in `/run` command, not configurable per-guild.

7. **No Analytics Dashboard**: Command logs are stored but not visualized anywhere.

### Known Bugs

1. **Class Button Label**: Button says "Class" but opens dropdown - could be clearer.

2. **No Validation on Startup**: Missing environment variables cause runtime errors instead of failing fast.

---

## Known Issues & Limitations

Let's be honest about what doesn't work perfectly or what's missing:

### What's Missing

**No Bench/Leave Buttons Yet**  
The UI only shows a "Join" button. The backend fully supports bench and leave states, but I haven't exposed them in the UI. You can join, but you can't mark yourself as benched or leave without the organizer ending the run.

**Can't View Who Joined**  
There's no `/viewrun` command to see the full list of participants. You have to rely on the counter in the embed. If you need details, you'd have to query the database directly.

**No Run History Command**  
All past runs are stored in the database, but there's no command to browse them. Want to see how many Shatters you organized last month? You can't... yet.

**Auto-End Duration is Fixed**  
Every run auto-ends after 2 hours. This is hardcoded in the `/run` command. If you want to change it, you need to modify the code.

**No Voice Channel Integration**  
The bot doesn't create or manage voice channels. You're on your own for that.

**Single-Server Focus**  
This bot has been primarily tested in one server. Multi-guild edge cases probably exist, especially around permission checking and role management.

### Known Bugs

**Missing Env Var Validation**  
If you forget to set environment variables, the bot crashes at runtime with cryptic errors instead of telling you upfront what's missing. Not ideal for first-time setup.

**Race Conditions on Run Status**  
If two organizers click "Start" or "End" at the exact same time, weird things can happen. The backend doesn't use optimistic locking, so both requests might go through.

**Bot Role Position Issues**  
If the bot's role is lower than a user's role, it can't manage them. Commands like `/suspend` will fail with a 403 error. The bot checks this for most operations, but not all.

**Quota Reset is Manual**  
The quota system has a reset datetime, but it doesn't automatically reset points. You have to manually update the `reset_at` field when a period ends.

### Performance Concerns

**No Caching Layer**  
Every permission check hits the database. For small servers this is fine, but if you have thousands of members, it might get slow. A Redis cache would help.

**No Rate Limiting**  
The backend has no rate limit protection. Someone could spam the API if they wanted to. This is mostly safe because the API key is private, but still.

**Leaderboard Fetching**  
Quota leaderboards fetch all members with a role, then query stats for each one. This works fine for <100 people but could be optimized with better SQL queries.

### Things That Could Go Wrong

**Orphaned Runs**  
If a channel or guild gets deleted while a run is active, the run stays in the database forever. There's no cleanup task for this.

**Discord Outages**  
If Discord goes down mid-operation, the bot's scheduled tasks (auto-end, suspension cleanup) will fail. They retry on the next run, but there could be delays.

**Database Migrations**  
There are 32 migration files. If you're setting up from scratch, they all run sequentially. If one fails halfway through, you need to manually fix it—there are no rollback scripts.

**Multi-Guild Quota**  
If you run this bot in multiple servers, quota is tracked per-guild but shares the same database. This is fine, but be aware that quota role configs are guild-specific.

---

## Troubleshooting

**Bot doesn't respond to commands**

- Check that slash commands are registered: `docker-compose logs bot | grep "Successfully registered"`
- Verify the bot has the correct permissions in your server (at minimum: Send Messages, Embed Links, Manage Roles)
- Make sure you've run `/setroles` to configure at least the organizer and verified_raider roles

**"NOT_ORGANIZER" error when creating runs**

- You need the Organizer role configured in `/setroles`
- Check that you actually have that Discord role assigned
- Verify the bot can see your roles (permission issue if you can't)

**Backend connection errors**

- Check `BACKEND_URL` in `bot/.env` matches where the backend is running
- Verify `BACKEND_API_KEY` matches in both `bot/.env` and `backend/.env`
- If using Docker: make sure services can communicate (check `docker-compose logs`)

**Database migration failures**

- Check PostgreSQL is running and accessible
- Verify `DATABASE_URL` format: `postgres://user:pass@host:port/database`
- Look at migration files in `backend/src/db/migrations/` to see which one failed
- You might need to manually fix the schema and re-run

**Verification not working**

- Make sure you've set up channels: `/setchannels getverified:#your-channel`
- For RealmEye verification, check that the service is accessible (sometimes it's down)
- For manual verification, ensure the manual_verification channel is configured
- Check that the bot has permission to send DMs (users must allow DMs from server members)

**Quota panels not updating**

- Verify the quota channel is set: `/setchannels quota:#your-channel`
- Make sure the bot has permission to send/edit messages in that channel
- Check that the role in `/configquota` actually exists and has members
- Try manually triggering an update by completing a run or logging quota

**Role management fails with 403 errors**

- The bot's role must be higher than the roles it's trying to manage
- Check role hierarchy in Server Settings > Roles
- The bot needs "Manage Roles" permission
- You can't manage Discord owners or administrators (this is a Discord limitation)

---

## ⚡ Optimization Opportunities

### Performance

1. **Database Indexes**
   - **Current**: Basic indexes on foreign keys
   - **Optimize**: Add composite indexes for common queries
   - **Example**: `(guild_id, status)` on `run` table
   - **Impact**: Faster run queries for active raids

2. **Caching Layer**
   - **Current**: No caching
   - **Optimize**: Add Redis for guild role/channel mappings
   - **Impact**: Reduce DB queries for every permission check
   - **Files**: New `backend/src/lib/cache.ts`

3. **Batch Operations**
   - **Current**: Auto-end processes runs one-by-one
   - **Optimize**: Batch status updates in single transaction
   - **Impact**: Faster cleanup tasks, reduced DB load

4. **Webhook Logging**
   - **Current**: Bot fetches channels and sends messages
   - **Optimize**: Use webhooks for audit logs
   - **Impact**: Faster, no rate limit concerns

### Code Quality

5. **Reduce Code Duplication**
   - **Problem**: Permission checks duplicated in every command
   - **Solution**: Create command middleware/decorators
   - **Files**: Create `bot/src/lib/command-decorators.ts`

6. **Extract Common Embed Builders**
   - **Problem**: Embed building logic scattered across files
   - **Solution**: Create reusable embed builder utilities
   - **Files**: Create `bot/src/lib/embed-builders.ts`

7. **Consolidate HTTP Client**
   - **Problem**: Some error handling inconsistent
   - **Solution**: Centralize all backend calls through http.ts
   - **Impact**: Consistent error handling across all commands

8. **Type Safety Improvements**
   - **Current**: Some `any` types in error handling
   - **Solution**: Create proper error type hierarchy
   - **Files**: `bot/src/lib/http.ts`, `backend/src/lib/errors.ts`

### Database

9. **Audit Table Pruning**
   - **Problem**: Audit table will grow indefinitely
   - **Solution**: Add archival strategy (move old logs to cold storage)
   - **Impact**: Faster queries, manageable storage

10. **Soft Deletes for Runs**
    - **Current**: Runs stay in DB forever
    - **Optimize**: Add `deleted_at` column, filter in queries
    - **Impact**: Cleaner data, better analytics

---

## 🚦 Next Steps for Feature Development

### Phase 1: Complete Core Features (Essential)

1. **Add Bench/Leave Buttons**
   - Add buttons to run embeds
   - Update handlers to call backend with state='bench' or state='leave'
   - Update embed to show "Bench: X" count
   - **Files**: `bot/src/commands/run.ts`, `bot/src/interactions/buttons/raids/join.ts`

2. **Reaction List Command**
   - **Command**: `/viewrun runid:123`
   - Show who joined, who's benched, class distribution
   - Paginated embed for large runs
   - **Files**: New `bot/src/commands/viewrun.ts`, `backend/src/routes/runs.ts` (add GET /runs/:id/reactions)

3. **Environment Validation**
   - Validate all env vars on startup
   - Fail fast with clear error messages
   - List missing/invalid variables
   - **Files**: `backend/src/server.ts`, `bot/src/index.ts`

4. **Analytics Dashboard**
   - Visualize command_log data
   - Show command usage statistics per guild
   - Error rate monitoring
   - **Files**: New dashboard or admin command

### Phase 2: Enhanced User Experience (High Value)

5. **Run History Command**
   - **Command**: `/runhistory [member] [dungeon] [days]`
   - Show past runs, success rate, most organized dungeons
   - Analytics for guilds
   - **Backend**: Add GET /runs endpoint with filters
   - **Files**: New `bot/src/commands/runhistory.ts`

6. **Leaderboards**
   - **Command**: `/leaderboard type:[organizers|raiders|dungeons]`
   - Show top organizers by run count
   - Show most active raiders
   - Show most popular dungeons
   - **Backend**: Add analytics queries
   - **Files**: New `bot/src/commands/leaderboard.ts`

7. **Direct Message Notifications**
   - DM users when run starts
   - DM users when run ends
   - Allow users to opt-in/opt-out
   - **Backend**: Add user preferences table
   - **Files**: `bot/src/interactions/buttons/run-status.ts`

8. **Enhanced Class System**
   - Validate class selection against dungeon requirements
   - Show "needed classes" in embed
   - Alert organizer when all required classes filled
   - **Files**: Use existing `keyReactions`/`otherReactions` in `bot/src/constants/DungeonData.ts`

### Phase 3: Advanced Features (Nice to Have)

9. **Voice Channel Integration**
   - Auto-create voice channel on run start
   - Auto-delete on run end
   - Move joined users to voice channel
   - **Files**: `bot/src/interactions/buttons/raids/run-status.ts`

10. **Custom Dungeon Management**
    - **Commands**: `/adddungeon`, `/editdungeon`, `/removedungeon`
    - Guild-specific custom dungeons
    - **Backend**: Add custom_dungeon table
    - **Files**: New `bot/src/commands/dungeon-*.ts`

11. **Advanced Headcount Features**
    - Afk check integration
    - Automatic role requirements checking
    - Scheduled headcounts (e.g., daily reset headcounts)
    - **Files**: Extend `bot/src/commands/headcount.ts`

12. **Run Templates**
    - Save common run configurations
    - Quick-create runs from templates
    - Template sharing between organizers
    - **Files**: New template management system

### Phase 4: Administration & Analytics (Power Features)

13. **Enhanced Audit Viewer**
    - **Command**: `/audit [action] [user] [days]`
    - Search audit logs from Discord
    - Export to CSV
    - **Backend**: Add search endpoint for audit table
    - **Files**: New `bot/src/commands/audit.ts`

14. **Backup/Export System**
    - Export all guild data to JSON
    - Import from backup
    - Scheduled auto-backups
    - **Backend**: Add export endpoints
    - **Files**: New `backend/src/routes/export.ts`

15. **Dashboard Web UI**
    - Web interface for guild stats
    - Visual charts for run history
    - User management interface
    - **Tech**: Next.js + same backend API
    - **Files**: New `dashboard/` directory

16. **Integration with ROTMG APIs**
    - Verify IGNs against RealmEye
    - Import character stats
    - Track in-game achievements
    - **Backend**: Add external API client
    - **Files**: New `backend/src/lib/realmeye.ts`

---

## 📊 Database Schema Diagram

```text
┌─────────────┐         ┌──────────────┐         ┌─────────────┐
│   guild     │         │    member    │         │   raider    │
├─────────────┤         ├──────────────┤         ├─────────────┤
│ id (PK)     │────┐    │ id (PK)      │────┐    │ guild_id    │◄──┐
│ name        │    │    │ username     │    │    │ user_id     │   │
│ created_at  │    │    │ created_at   │    │    │ ign         │   │
└─────────────┘    │    └──────────────┘    │    │ status      │   │
                   │                        │    │ verified_at │   │
┌─────────────┐    │    ┌──────────────┐    │    │ created_at  │   │
│ guild_role  │    │    │guild_channel │    │    └─────────────┘   │
├─────────────┤    │    ├──────────────┤    │            ▲         │
│ guild_id    │◄───┘    │ guild_id     │◄───┘            │         │
│ role_key    │         │ channel_key  │                 │         │
│discord_role │         │discord_chan  │                 │         │
└─────────────┘         └──────────────┘                 │         │
   (9 roles:                (4 channels:                 │         │
    admin, mod,              raid, veri_log,             │         │
    head_org,                punishment_log,             │         │
    officer,                 quota)                      │         │
    security,                                            │         │
    organizer,                                           │         │
    verified,                                            │         │
    suspended,                                           │         │
    team)                                                │         │
                                                         │         │
                   ┌─────────────────────────────────────┘         │
                   │                                               │
                   ▼                                               │
┌─────────────────────────────────────────────┐                   │
│                 run                         │                   │
├─────────────────────────────────────────────┤                   │
│ id (PK)                                     │                   │
│ guild_id (FK) ──────────────────────────────┼───────────────────┘
│ organizer_id (FK) ──────────────────────────┼───────────────────┐
│ dungeon_key                                 │                   │
│ dungeon_label                               │                   │
│ description, party, location                │                   │
│ status (open/live/ended/cancelled)          │                   │
│ channel_id, post_message_id                 │                   │
│ auto_end_minutes                            │                   │
│ key_window_ends_at                          │                   │
│ created_at, started_at, ended_at            │                   │
└─────────────────────────────────────────────┘                   │
                   │                                               │
                   │                                               │
                   ▼                                               │
┌─────────────────────────────────────────────┐                   │
│              reaction                       │                   │
├─────────────────────────────────────────────┤                   │
│ run_id (FK, PK)                             │                   │
│ user_id (FK, PK)                            │                   │
│ state (join/bench/leave)                    │                   │
│ class (optional)                            │                   │
│ updated_at                                  │                   │
└─────────────────────────────────────────────┘                   │
                                                                  │
┌─────────────────────────────────────────────┐                   │
│              punishment                     │                   │
├─────────────────────────────────────────────┤                   │
│ id (PK, 24-char hex)                        │                   │
│ guild_id (FK)                               │                   │
│ user_id (FK)                                │                   │
│ moderator_id (FK) ──────────────────────────┼───────────────────┘
│ type (warn/suspend)                         │
│ reason                                      │
│ expires_at (nullable)                       │
│ active                                      │
│ removed_at, removed_by, removal_reason      │
│ created_at                                  │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│            quota_event                      │
├─────────────────────────────────────────────┤
│ id (PK)                                     │
│ guild_id (FK)                               │
│ actor_user_id (FK)                          │
│ action_type (run_completed/verify_member)   │
│ subject_id (optional, for idempotency)      │
│ dungeon_key (optional)                      │
│ points (for raiders - future)               │
│ quota_points (for organizers/verifiers)     │
│ created_at                                  │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│          quota_role_config                  │
├─────────────────────────────────────────────┤
│ guild_id (PK)                               │
│ discord_role_id (PK)                        │
│ required_points                             │
│ reset_at (absolute datetime)                │
│ panel_message_id (nullable)                 │
│ created_at (quota period start tracking)    │
│ updated_at                                  │
└─────────────────────────────────────────────┘
                   │
                   │
                   ▼
┌─────────────────────────────────────────────┐
│        quota_dungeon_override               │
├─────────────────────────────────────────────┤
│ guild_id (PK, FK)                           │
│ discord_role_id (PK, FK)                    │
│ dungeon_key (PK)                            │
│ points                                      │
│ updated_at                                  │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│                audit                        │
├─────────────────────────────────────────────┤
│ id (PK)                                     │
│ guild_id (FK, nullable)                     │
│ actor_id (FK, nullable)                     │
│ action                                      │
│ subject                                     │
│ meta (JSONB)                                │
│ created_at                                  │
└─────────────────────────────────────────────┘
```

---

## 🧪 Testing Strategy (Not Yet Implemented)

### Recommended Testing Approach

1. **Unit Tests**
   - Test Zod schemas validation
   - Test authorization helpers
   - Test dungeon search/filter logic
   - **Tool**: Vitest or Jest

2. **Integration Tests**
   - Test backend API endpoints
   - Test database migrations
   - Test permission checks end-to-end
   - **Tool**: Supertest + test database

3. **E2E Tests**
   - Test Discord command flows
   - Test button interactions
   - Test punishment lifecycle
   - **Tool**: Discord.js test utilities

4. **Load Testing**
   - Test concurrent run creation
   - Test mass user reactions
   - Test auto-end task under load
   - **Tool**: k6 or Artillery

---

---

## � Suggestions for Future Improvements

### Code Organization & Architecture

1. **Modularize Backend Routes**
   - **Current**: All logic in route files (runs.ts, quota.ts, etc.)
   - **Improvement**: Extract business logic into service layer (`services/run-service.ts`, `services/quota-service.ts`)
   - **Benefit**: Easier testing, better separation of concerns, reusable business logic
   - **Priority**: Medium (code works but could be cleaner)

2. **Implement Repository Pattern for Database**
   - **Current**: Raw SQL queries scattered across lib files
   - **Improvement**: Create repository classes (`repositories/RunRepository.ts`, `repositories/QuotaRepository.ts`)
   - **Benefit**: Centralize database logic, easier to mock for testing, consistent query patterns
   - **Priority**: Medium

3. **Add Request/Response DTOs**
   - **Current**: Type definitions inline or implicit
   - **Improvement**: Create explicit DTO (Data Transfer Object) classes with validation
   - **Benefit**: Better type safety, self-documenting API, easier to maintain
   - **Priority**: Low

4. **Consolidate Error Handling**
   - **Current**: Mix of try-catch blocks and BackendError class
   - **Improvement**: Unified error middleware, custom error hierarchy
   - **Benefit**: Consistent error responses, better error tracking
   - **Priority**: High

### Performance & Scalability

5. **Add Caching Layer (Redis)**
   - **Current**: Every permission check queries database
   - **Target**: Cache guild role/channel mappings, quota configs
   - **Benefit**: Reduce database load, faster permission checks
   - **Priority**: Medium (only needed for larger servers)

6. **Optimize Quota Leaderboard Queries**
   - **Current**: Fetches all members, then filters
   - **Improvement**: Use database aggregation, pagination
   - **Benefit**: Faster leaderboard updates, less memory usage
   - **Priority**: Low (works fine for <1000 members per role)

7. **Batch Database Operations**
   - **Current**: Auto-end processes runs one-by-one
   - **Improvement**: Batch update multiple runs in single transaction
   - **Benefit**: Faster cleanup tasks, reduced database connections
   - **Priority**: Low

8. **Add Rate Limiting**
   - **Current**: No protection against API abuse
   - **Improvement**: Implement Fastify rate limit plugin
   - **Benefit**: Prevent spam, protect backend from DOS
   - **Priority**: Medium

### Testing & Quality

9. **Implement Unit Tests**
   - **Coverage**: Authorization logic, quota calculations, dungeon search
   - **Tools**: Vitest or Jest
   - **Priority**: High (critical for maintaining code quality as features grow)

10. **Add Integration Tests**
    - **Coverage**: API endpoints, database migrations, permission flows
    - **Tools**: Supertest + test database
    - **Priority**: High

11. **Add End-to-End Tests**
    - **Coverage**: Discord command flows, button interactions
    - **Tools**: Discord.js testing utilities
    - **Priority**: Medium

12. **Set Up CI/CD Pipeline**
    - **Current**: Manual deployment
    - **Improvement**: GitHub Actions for tests, lint, build, deploy
    - **Benefit**: Catch bugs before production, automated deployments
    - **Priority**: Medium

### Features & User Experience

13. **Add Bench/Leave Buttons**
    - **Current**: Only "Join" button visible (backend supports bench/leave)
    - **Improvement**: Add buttons to run embeds, update handlers
    - **Benefit**: Complete reaction state management
    - **Priority**: High (partially implemented in backend)

14. **Raider Participation Tracking**
    - **Current**: Only organizers and verifiers earn quota points
    - **Improvement**: Track raider participation (joins, completes), use `points` field
    - **Benefit**: Reward active raiders, not just organizers
    - **Priority**: Medium (requires design decisions on how to track "completion")

15. **Automated Quota Reset**
    - **Current**: Manual reset via "Reset Panel" button
    - **Improvement**: Scheduled task to auto-reset at configured datetime
    - **Benefit**: Hands-off quota management
    - **Priority**: Medium

16. **Run History & Analytics**
    - **Command**: `/runhistory [member] [dungeon] [days]`
    - **Show**: Past runs, completion rates, most organized dungeons
    - **Priority**: Low (data exists, just needs query + command)

17. **Enhanced Leaderboards**
    - **Command**: `/leaderboard type:[organizers|raiders|dungeons]`
    - **Show**: Server-wide stats, not just per-role
    - **Priority**: Low

18. **Voice Channel Integration**
    - **Feature**: Auto-create voice channel on run start, delete on end
    - **Benefit**: Streamlined raid experience
    - **Priority**: Low (nice-to-have)

19. **Afk Check System**
    - **Feature**: React-to-join window before run starts
    - **Benefit**: Ensure participants are active
    - **Priority**: Low

20. **Custom Dungeon Management**
    - **Commands**: `/adddungeon`, `/editdungeon`
    - **Benefit**: Support guild-specific custom dungeons
    - **Priority**: Low

### DevOps & Monitoring

21. **Structured Logging**
    - **Current**: `console.log` and basic Fastify logger
    - **Improvement**: Pino or Winston with log levels, structured format
    - **Benefit**: Better debugging, log aggregation (e.g., ELK stack)
    - **Priority**: Medium

22. **Health Checks & Monitoring**
    - **Current**: Basic `/health` endpoint
    - **Improvement**: Liveness/readiness probes, metrics (Prometheus)
    - **Benefit**: Better uptime monitoring, easier Kubernetes deployment
    - **Priority**: Low (unless deploying to production cluster)

23. **Environment Variable Validation**
    - **Current**: Runtime crashes if env vars missing
    - **Improvement**: Zod schema validation on startup
    - **Benefit**: Fail fast with clear error messages
    - **Priority**: High

24. **Database Migration Rollback**
    - **Current**: Migrations only go forward
    - **Improvement**: Add down migrations for rollback
    - **Benefit**: Safer deployments, easier to revert
    - **Priority**: Medium

### Documentation & Onboarding

25. **API Documentation**
    - **Tool**: Swagger/OpenAPI for backend routes
    - **Benefit**: Self-documenting API, easier integration
    - **Priority**: Low

26. **Developer Setup Guide**
    - **Content**: Step-by-step local development setup
    - **Benefit**: Easier for new contributors
    - **Priority**: Low

27. **Architecture Decision Records (ADRs)**
    - **Document**: Why certain patterns were chosen
    - **Benefit**: Context for future maintainers
    - **Priority**: Low

---

## 📊 Current Status Summary

- 🟢 **Core Functionality**: Fully working
  - ✅ Run management (create, start, end, auto-end)
  - ✅ Raider verification with IGN management (automated & manual)
  - ✅ Dual verification methods (RealmEye + manual screenshot)
  - ✅ Punishment system (warnings, suspensions with auto-expiry)
  - ✅ Role-based permission system
  - ✅ Guild configuration (roles, channels)

- 🟢 **Quota System**: Production ready
  - ✅ Automatic tracking for organizers and verifiers
  - ✅ Configurable point values per dungeon per role
  - ✅ Decimal point support (0.5, 1.25, etc.)
  - ✅ Real-time leaderboard panels
  - ✅ Manual logging and adjustments
  - ✅ Statistics view for all members

- 🟢 **Verification System**: Production ready
  - ✅ RealmEye automated verification
  - ✅ Manual screenshot verification with ticket system
  - ✅ Security+ approval workflow
  - ✅ Custom instructions per guild
  - ✅ Full audit trail

- � **Team Role Management**: Production ready
  - ✅ Auto-assignment on role changes
  - ✅ Event-driven synchronization
  - ✅ Manual bulk sync command

- 🔴 **Testing & CI/CD**: Not implemented
  - ❌ No automated tests
  - ❌ No CI/CD pipeline
  - ❌ Manual deployment only

- ⚡ **Performance**: Good for small-medium servers
  - ✅ Connection pooling configured
  - ✅ Indexed database queries
  - ⚠️ No caching layer (may be slow for very large servers)
  - ⚠️ No rate limiting (vulnerable to spam)

---

## ✨ Recently Added Features (v0.3.0)

### Manual Verification System
- **Dual verification methods** - Users can choose between RealmEye or manual screenshot verification
- **Ticket-based review** - Manual verifications create tickets in manual_verification channel
- **Security+ approval** - Staff can approve or deny with reasons
- **Custom instructions** - Configure guild-specific instructions for screenshot requirements
- **Full audit trail** - Track all verification attempts, denials, and approvals
- **DM notifications** - Users receive DMs about verification status
- **Session management** - Extends existing verification session system
- **Screenshot storage** - Links to uploaded screenshots preserved in tickets

### Decimal Point Support
- **Fractional points** - Award 0.5, 1.25, 2.75, etc. points for quota and raider participation
- **Precise tracking** - Up to 2 decimal places supported (DECIMAL(10,2))
- **All point systems** - Applies to quota points, raider points, and key pop points
- **Backward compatible** - Integer values still work perfectly
- **Flexible configuration** - Set any decimal value in `/configquota`, `/configpoints`, etc.

### Bot Log Channel
- **General logging** - New channel type for non-specific bot activity
- **Command execution** - Optional logging of command usage to dedicated channel
- **Configurable via `/setchannels`** - Add `bot_log` channel to your guild
- **Centralized activity** - Track bot actions that don't fit other log categories

### Previous Features (v0.2.0)

### Headcount System
- **Lightweight interest gauging** - `/headcount` command creates panels to see who's interested in upcoming runs
- **Multi-dungeon support** - Select up to 10 dungeons in a single headcount
- **Key offering tracking** - Users can indicate which dungeons they can pop keys for
- **Convert to run** - Organizers can convert a headcount directly to a full run
- **Thread organization** - Automatically creates threads in raid-log channel for each headcount
- **Participant management** - Real-time tracking of who joined and what keys they're offering

### Command Execution Logging
- **Analytics & debugging** - All slash commands are logged with metadata for analysis
- **Performance tracking** - Latency measurements for each command execution
- **Error categorization** - Failed commands are categorized by error type
- **Privacy-conscious** - Sensitive data is sanitized before storage
- **Queryable data** - Indexed for efficient analytics by guild, command, user, and error

### Raid Logging & Thread Management
- **Organized event tracking** - Each run/headcount gets its own thread in raid-log channel
- **Centralized logging** - All raid events logged to dedicated threads
- **Better organization** - No more cluttered log channels, each raid has its own space
- **In-memory caching** - Thread IDs cached for performance
- **Automatic cleanup** - Old threads can be archived or deleted

### RealmEye Verification System
- **Automated verification flow** - Users click "Get Verified" button → DM-based multi-step verification
- **Session management** - 1-hour timeout for verification sessions
- **RealmEye integration** - Generates verification codes users add to their RealmEye profile
- **Configurable panel** - `/configverification` sends interactive verification panel to configured channel
- **Manual override** - Staff can still use `/verify` for manual verification

### Raider Points System
- **Guild-wide configuration** - `/configpoints` to set points per dungeon for raiders
- **Interactive panels** - Select dungeons from dropdown, set custom point values
- **Separate from quota** - Raiders earn "points" for participation, organizers earn "quota_points"
- **Manual adjustments** - `/addpoints` to award or deduct points for special circumstances

### Key Pop Tracking
- **Per-dungeon tracking** - Track which raiders popped keys for which dungeons
- **Point rewards** - Configurable points awarded for popping keys
- **Manual logging** - `/logkey` to log key pops retroactively or for offline events
- **Statistics integration** - Key pops shown in `/stats` output

### Staff Notes System
- **Silent notes** - Add observations/informal warnings visible only to Security+ staff
- **Separate from punishments** - Notes don't affect raider status but provide context
- **Audit trail** - Full tracking of who added notes and when
- **Integrated view** - Notes shown alongside punishments in `/checkpunishments`

### Enhanced Moderation & Organization
- **Role-specific permissions** - Security+ for verification/warnings, Officer+ for point adjustments
- **Manual point management** - `/addquotapoints` and `/addpoints` for corrections
- **Improved error handling** - Better error messages with actionable guidance
- **Help command** - `/help` with category filtering for easy command discovery
- **Permission middleware** - Centralized permission checking in `lib/permissions/`
- **Interaction permissions** - Helper utilities for button/modal permission checks

### Infrastructure Improvements
- **Organized command structure** - Commands split into `/commands/conifgs/` and `/commands/moderation/`
- **Shared utilities** - `interaction-helpers.ts`, `error-handler.ts`, `embed-builders.ts` for code reusability
- **Permission helpers** - Centralized permission checking with `command-middleware.ts`
- **Structured logging** - Logger utilities in both backend and bot for better debugging
- **Database migrations** - 30 total migrations (001-030) for complete schema evolution
- **RealmEye service** - Dedicated service module for RealmEye API integration with README documentation

---

## Contributing

Want to improve the bot? Here's how:

### Getting Started

1. Fork the repo and clone it locally
2. Set up the development environment (see [Installation](#installation))
3. Pick something to work on—check the [Known Issues](#known-issues--limitations) section for ideas
4. Make your changes and test them thoroughly

### Code Style

- Use TypeScript for everything
- Run the existing code through your formatter before committing
- Add JSDoc comments for complex functions
- Use Zod for input validation
- Keep functions focused—if it's doing too much, split it up

### Testing Your Changes

Right now there are no automated tests (yeah, I know). Test manually by:

- Creating runs and interacting with buttons
- Testing permission checks with different roles
- Verifying edge cases (missing config, invalid input, etc.)
- Checking database state after operations

If you want to add tests, that would be amazing. Look at the file structure and create tests in a `__tests__` directory.

### Pull Request Guidelines

- Write a clear description of what your PR does
- Reference any related issues
- Make sure the bot still starts up and basic commands work
- If you're adding a new feature, update this README

### Areas That Need Help

- **Tests**: We need unit tests, integration tests, any tests really
- **Environment validation**: Add startup checks for required env vars
- **Bench/Leave buttons**: Expose the backend functionality in the UI
- **Run history command**: Query and display past runs
- **Voice integration**: Auto-create voice channels for runs
- **Performance**: Add Redis caching, optimize queries, add rate limiting
- **Documentation**: More examples, better error messages, video tutorials

---

## Technical Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Bot Framework | Discord.js 14 | Best maintained Discord library for Node.js |
| Backend API | Fastify | Fast, low overhead, great TypeScript support |
| Database | PostgreSQL 14 | Reliable, powerful, handles our relational data well |
| Language | TypeScript | Type safety catches bugs before they hit production |
| Runtime | Node.js 18+ | Modern JS features, stable LTS release |
| Validation | Zod | Runtime type checking, great DX |
| Containers | Docker Compose | Easy dev environment, consistent deploys |

---

## License

Not specified yet. If you're planning to open source this, add a LICENSE file (MIT is a good default for community projects).

---

## Acknowledgments

Built for the ROTMG community by raiders who got tired of managing runs in spreadsheets.

Special thanks to:
- The Discord.js team for maintaining an excellent library
- The Fastify team for a lightning-fast web framework
- Everyone who's tested this bot and reported bugs

---

## Support

Need help? Here's what to do:

1. Check the [Troubleshooting](#troubleshooting) section first
2. Look through existing GitHub issues to see if someone else had the same problem
3. If you found a bug, create a new issue with:
   - What you were trying to do
   - What happened instead
   - Error messages (check `docker-compose logs`)
   - Your setup (Docker? Manual? Which OS?)

For feature requests, open an issue with the "enhancement" label and describe what you want and why it would be useful.

---

**Last Updated**: November 14, 2025  
**Version**: 0.3.0  
**Status**: Production ready, actively maintained
