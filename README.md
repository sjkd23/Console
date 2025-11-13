# ROTMG Raid Bot - Complete Documentation

A comprehensive Discord bot system for organizing and managing Realm of the Mad God (ROTMG) dungeon raids. Built with Discord.js (bot) and Fastify (backend API), backed by PostgreSQL, featuring role-based permissions, punishment tracking, automated RealmEye verification, raider/organizer points system, quota tracking, key pop logging, and staff notes.

**Version:** 0.2.0  
**Last Updated:** November 13, 2025  
**Status:** ✅ Production Ready

---

## 🎯 Architecture Overview

### System Components

```text
┌─────────────────┐
│  Discord Users  │
└────────┬────────┘
         │
         │ Slash Commands & Interactions
         ▼
┌─────────────────────────────────────────┐
│          Discord.js Bot                 │
│  ─────────────────────────────────────  │
│  • Command Handlers                     │
│  • Button/Modal Interactions            │
│  • Event Listeners (Role Changes)       │
│  • Auto Tasks (Run End, Suspensions,    │
│    Verification Cleanup)                │
│  • Quota Panel Management               │
│  • Team Role Auto-Assignment            │
│  • RealmEye Verification Flow (DMs)     │
└────────┬────────────────────────────────┘
         │
         │ HTTP REST API
         │ (Backend URL + API Key Auth)
         ▼
┌─────────────────────────────────────────┐
│         Fastify Backend API             │
│  ─────────────────────────────────────  │
│  • Role-Based Authorization             │
│  • Run Management (CRUD)                │
│  • Raider Verification                  │
│  • Punishment System                    │
│  • Quota Tracking & Leaderboards        │
│  • Raider Points Configuration          │
│  • Key Pop Tracking & Points            │
│  • Staff Notes System                   │
│  • RealmEye Verification Sessions       │
│  • Guild Configuration                  │
└────────┬────────────────────────────────┘
         │
         │ PostgreSQL Connection Pool
         ▼
┌─────────────────────────────────────────┐
│       PostgreSQL Database               │
│  ─────────────────────────────────────  │
│  • Guilds & Members                     │
│  • Raiders & Verifications              │
│  • Runs & Reactions                     │
│  • Punishments & Audit Logs             │
│  • Quota Events & Configurations        │
│  • Role & Channel Mappings              │
└─────────────────────────────────────────┘
```

### Data Flow Examples

**Creating a Run:**

1. User runs `/run dungeon:Shatters` in Discord
2. Bot validates permissions via backend `/guilds/:id/roles`
3. Bot calls backend `POST /runs` with organizer ID and dungeon info
4. Backend creates database record and returns run ID
5. Bot posts embed with buttons in Discord channel
6. Bot calls backend to link Discord message ID to run

**Completing a Run (Auto Quota):**

1. Organizer clicks "End" button on run embed
2. Bot calls backend `PATCH /runs/:id` with status='ended'
3. Backend updates run status and automatically logs quota event
4. Backend calculates points based on dungeon overrides for organizer's roles
5. Bot updates embed to show "Ended" status
6. Bot triggers quota panel update for organizer's roles
7. Quota leaderboard panels update in real-time

**Role Change (Team Role Sync):**

1. Admin assigns @Raid Leader role to member
2. Discord fires GuildMemberUpdate event
3. Bot detects role change
4. Bot fetches guild role config from backend
5. Bot checks if member has any staff roles
6. Bot automatically assigns @Team role
7. Process reversed when staff roles are removed

---

## 🎮 Quota System Deep Dive

The quota system tracks and rewards organizer and verifier activity, providing leaderboards and progress tracking.

### How It Works

**Points vs Quota Points:**

- **quota_points**: For organizers (organizing runs) and verifiers (verifying members) - currently active
- **points**: For raiders (completing runs, popping keys) - fully implemented with raider points config and key pop tracking

**Automatic Tracking:**

- When a run is ended (via "End" button or auto-end), a quota event is automatically logged
- When a member is verified (manual `/verify` or automated RealmEye verification), a quota event is automatically logged
- When keys are logged via `/logkey`, key pop points are tracked and awarded based on configuration
- Points are awarded based on dungeon type and role-specific overrides

**Configurable Point Values:**

- Default: 1 point per run completed, 1 point per verification
- Per-dungeon overrides: Set custom point values (e.g., Shatters = 3 points, Fungal = 2 points)
- Per-role configuration: Different roles can have different point values for the same dungeon

**Quota Periods:**

- Configured with absolute datetime resets (e.g., "Resets on December 1, 2025 at 00:00 UTC")
- `created_at` tracks when the current quota period started
- `reset_at` defines when the next reset occurs
- After reset, manually update `reset_at` to the next period and `created_at` to NOW

**Leaderboard Panels:**

- Auto-updating embeds posted in the quota channel
- Show top 25 members with quota points
- Display who has met quota (✅) and who hasn't
- Include rank indicators (🥇🥈🥉)
- Update in real-time when runs end or verifications occur

### Configuration Workflow

1. **Set up role**: `/configquota role:@Raid Leader`
2. **Configure basics**: Click "Set Basic Config" button
   - Set required points (e.g., 10 points to meet quota)
   - Set reset datetime (e.g., 2025-12-01T00:00:00Z)
3. **Set dungeon overrides**: Click "Configure Dungeons" button
   - Select dungeon from dropdown
   - Enter point value (e.g., 3 for Shatters)
4. **Create panel**: Click "Update Panel" button
   - Bot posts leaderboard in quota channel
   - Panel auto-updates when quota events occur
5. **Reset quota**: Click "Reset Panel" button when period ends
   - Updates `created_at` to NOW (start new period)
   - Keeps same `reset_at` until you update it

### Manual Quota Management

**Manually log runs** (for retroactive tracking or corrections):

```text
/logrun dungeon:Shatters amount:1
/logrun dungeon:Fungal amount:-1  # Remove 1 point
```

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
│       ├── server.ts                  # ✅ Main Fastify server entrypoint
│       ├── config.ts                  # ✅ Configuration loader and validation
│       │
│       ├── db/
│       │   ├── pool.ts                # ✅ PostgreSQL connection pool
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
│       │       └── 027_command_log.sql      # Command execution logging
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
        │           └── get-verified.ts         # ✅ RealmEye verification flow initiation
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
            ├── run-auto-end.ts        # ✅ Automatic run expiration task (5-min intervals)
            ├── suspension-cleanup.ts  # ✅ Automatic suspension expiration task (1-min intervals)
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
- ✅ `/configverification` - Send RealmEye verification panel (Moderator+ role)
  - Send interactive verification panel to get-verified channel
  - Enables automated RealmEye-based verification flow
  - Users click button → DM flow → verify via RealmEye

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
  - Used for logging (veri_log, punishment_log, raid_log, quota, getverified)
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
- ✅ Multi-step verification: IGN → RealmEye code → verification
- ✅ Session management with 1-hour timeout
- ✅ Automatic role assignment and nickname setting
- ✅ IGN conflict detection and validation
- ✅ Manual verification override via `/verify` command
- ✅ Configurable get-verified channel via `/setchannels`

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

## 🚀 Setup & Deployment

### Docker Compose (Recommended)

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd rotmg-raid-bot
   ```

2. **Configure environment variables**
   
   Create `backend/.env`:
   ```env
   PORT=4000
   BACKEND_API_KEY=your_secret_key_here
   DATABASE_URL=postgres://postgres:postgres@db:5432/rotmg_raids
   ```

   Create `bot/.env`:
   ```env
   APPLICATION_ID=your_discord_app_id
   SECRET_KEY=your_discord_bot_token
   DISCORD_DEV_GUILD_ID=your_test_server_id
   BACKEND_URL=http://backend:4000/v1
   BACKEND_API_KEY=your_secret_key_here  # must match backend
   ```

3. **Start all services**
   ```bash
   docker-compose up -d
   ```

   This will:
   - Start PostgreSQL database on port 5469
   - Run migrations automatically
   - Start backend API on port 4000
   - Start bot and register commands

4. **Verify everything is running**
   ```bash
   docker-compose ps
   docker-compose logs -f bot
   ```

### Manual Setup (Without Docker)

#### Backend

1. **Install dependencies**
   ```bash
   cd backend
   npm install
   ```

2. **Configure environment** (create `backend/.env`)
   ```env
   PORT=4000
   BACKEND_API_KEY=your_secret_key_here
   DATABASE_URL=postgresql://user:password@localhost:5432/rotmg_raids
   ```

3. **Run migrations**
   ```bash
   npm run migrate
   ```

4. **Start server**
   ```bash
   npm run dev    # Development with hot reload
   npm run build && npm start  # Production
   ```

#### Bot

1. **Install dependencies**
   ```bash
   cd bot
   npm install
   ```

2. **Configure environment** (create `bot/.env`)
   ```env
   APPLICATION_ID=your_discord_app_id
   SECRET_KEY=your_discord_bot_token
   DISCORD_DEV_GUILD_ID=your_test_server_id
   BACKEND_URL=http://localhost:4000/v1
   BACKEND_API_KEY=your_secret_key_here
   ```

3. **Register slash commands**
   ```bash
   npm run register
   ```

4. **Start bot**
   ```bash
   npm run dev    # Development with hot reload
   npm run build && npm start  # Production
   ```

---

## 📋 Initial Configuration in Discord

After deploying the bot, follow these steps in your Discord server:

### 1. Configure Roles (Required)

Run `/setroles` to map your Discord roles to internal bot roles:

```
/setroles
  administrator: @Admin         # Can configure bot settings
  moderator: @Moderator         # Can issue punishments
  security: @Security           # Can verify raiders
  organizer: @Raid Leader       # Can create and manage runs
  verified_raider: @Verified    # Auto-assigned on verification
  suspended: @Suspended         # Auto-assigned on suspension
  team: @Team                   # Auto-assigned to members with staff roles
```

**Important:** At minimum, configure `organizer`, `security`, and `verified_raider` for core functionality. The `team` role is optional but recommended for automatic staff role management.

### 2. Configure Channels (Optional but Recommended)

Run `/setchannels` to set up logging channels:

```
/setchannels
  veri_log: #verification-log         # Logs all verifications
  punishment_log: #moderation-log     # Logs all punishments
  raid: #raids                        # Where runs are posted
  raid_log: #raid-logs                # Where raid event threads are created
  quota: #quota-leaderboards          # Where quota leaderboards are displayed
  getverified: #get-verified          # Where verification panel is posted
```

### 3. Configure Quota (Optional)

If you want to track organizer/verifier activity, set up quota for specific roles:

```
/configquota role:@Raid Leader
```

This opens an interactive panel where you can:

- Set required points per quota period
- Configure reset schedule (absolute datetime)
- Set per-dungeon point overrides (e.g., make Shatters worth 3 points instead of 1)
- Create/update leaderboard panels that auto-update

### 4. Verify Setup

1. Test creating a run: `/run dungeon:Shatters`
2. Test verification: `/verify member:@User ign:PlayerName`
3. Check that logs appear in configured channels
4. If using quota: `/stats` to view your quota statistics

---

## 🎮 Usage Examples

### Creating a Raid

```
/run dungeon:Shatters party:Nexus2 location:USEast
```

The bot will:
1. Create a database record
2. Post an embed with Join/Class/Organizer Panel buttons
3. Track reactions and class selections
4. Allow organizer to Start → End the run
5. Auto-end after 2 hours if not manually ended

### Verifying a Raider

```
/verify member:@NewPlayer ign:ProPlayer123
```

The bot will:
1. Check your Security role
2. Check for IGN conflicts
3. Update database with IGN and verified status
4. Set member's nickname to IGN
5. Assign verified_raider role
6. Log to veri_log channel

### Issuing a Suspension

```
/suspend member:@BadPlayer duration_days:3 reason:Repeated rule violations
```

The bot will:
1. Check your Moderator role
2. Create punishment record
3. Assign suspended role
4. Log to punishment_log channel
5. Automatically remove role after 3 days

### Checking Punishments

```
/checkpunishments member:@Player
```

Shows paginated list of all punishments for the user (active and removed).

---

## 🐛 Known Issues & Limitations

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

## 🔧 Issues to Fix

### High Priority Fixes

1. **Environment Variable Validation**
   - **Problem**: Bot/backend crash at runtime if env vars are missing
   - **Solution**: Add startup validation using Zod schemas
   - **Files**: `backend/src/server.ts`, `bot/src/index.ts`

2. **Logging System**
   - **Problem**: Using basic `console.log`, hard to debug production issues
   - **Solution**: Implement structured logging (pino or winston)
   - **Benefit**: Better debugging, log levels, formatting

3. **Error Recovery in Tasks**
   - **Problem**: Auto-end and suspension cleanup tasks may crash on errors
   - **Solution**: Add comprehensive try-catch with error logging
   - **Files**: `bot/src/lib/run-auto-end.ts`, `bot/src/lib/suspension-cleanup.ts`

4. **Race Conditions in Run Status**
   - **Problem**: Multiple organizers could click Start/End simultaneously
   - **Solution**: Add optimistic locking or transaction-level checks
   - **Files**: `backend/src/routes/runs.ts`

### Medium Priority Fixes

5. **Bot Role Position Checks**
   - **Problem**: Bot tries to manage users above its role, causes 403s
   - **Solution**: Add role hierarchy check before all role operations
   - **Files**: All command files that modify roles

6. **Orphaned Runs**
   - **Problem**: If channel/guild is deleted, runs remain in database
   - **Solution**: Add cleanup task to detect and archive orphaned runs

7. **Duplicate IGN Check Case Sensitivity**
   - **Problem**: "PlayerName" and "playername" are treated as different
   - **Solution**: Already using LOWER() in queries - verify consistency
   - **Files**: `backend/src/routes/raiders.ts`

8. **No Retry Logic for Backend Calls**
   - **Problem**: Temporary network issues cause command failures
   - **Solution**: Add retry logic with exponential backoff
   - **Files**: `bot/src/lib/http.ts`

### Low Priority Fixes

9. **No Rate Limiting**
   - **Problem**: No protection against API abuse
   - **Solution**: Add Fastify rate limiting plugin
   - **Files**: `backend/src/server.ts`

10. **No Database Connection Pooling Limits**
    - **Problem**: Could exhaust connections under heavy load
    - **Solution**: Configure proper pool sizes in pool.ts
    - **Files**: `backend/src/db/pool.ts`

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
  - ✅ Raider verification with IGN management
  - ✅ Punishment system (warnings, suspensions with auto-expiry)
  - ✅ Role-based permission system
  - ✅ Guild configuration (roles, channels)

- 🟢 **Quota System**: Production ready
  - ✅ Automatic tracking for organizers and verifiers
  - ✅ Configurable point values per dungeon per role
  - ✅ Real-time leaderboard panels
  - ✅ Manual logging and adjustments
  - ✅ Statistics view for all members

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

## ✨ Recently Added Features (v0.2.0)

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
- **Database migrations** - 27 total migrations (001-027) for complete schema evolution
- **RealmEye service** - Dedicated service module for RealmEye API integration with README documentation

---

## 📝 Contributing

Interested in contributing? Here's how to get started:

1. **Set up development environment** (see Setup section above)
2. **Pick an issue or improvement** from the suggestions above
3. **Create a feature branch**: `git checkout -b feature/your-feature-name`
4. **Make your changes** with clear, commented code
5. **Test thoroughly** (manual testing required until automated tests are added)
6. **Commit with descriptive messages**: `git commit -m "Add quota reset automation"`
7. **Push and create a Pull Request**

**Coding Standards:**

- TypeScript for all new code
- Use Zod for validation
- Follow existing patterns for consistency
- Add comments for complex logic
- Update README if adding user-facing features

---

## 📄 License

Not specified. Consider adding a LICENSE file (MIT, Apache 2.0, GPL, etc.).

---

## 🙏 Acknowledgments

- Built for the Realm of the Mad God community
- Powered by Discord.js for Discord bot functionality
- Fastify for high-performance backend API
- PostgreSQL for reliable data persistence
- Docker for containerized development environment

---

## 📞 Support & Contact

For issues, questions, or feature requests:

1. Check existing GitHub issues
2. Create a new issue with detailed description
3. Join the Discord server (if applicable)
4. Contact the maintainer

---

**Last Updated**: November 13, 2025  
**Maintained By**: ROTMG Raid Bot Development Team
