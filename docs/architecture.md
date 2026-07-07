# Architecture Guide

Technical architecture overview for contributors and developers.

**Audience:** Developers contributing to the codebase, system administrators, and technical staff.

---

## System Overview

The RotMG Raid Bot is a full-stack application with three primary components:

```
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│   Discord Bot   │────────▶│  Fastify API    │────────▶│   PostgreSQL    │
│   (Discord.js)  │◀────────│   (Backend)     │◀────────│   (Database)    │
└─────────────────┘         └─────────────────┘         └─────────────────┘
        │                            │                            │
        │                            │                            │
    Commands                      REST API                    Migrations
    Interactions                 Auth/Logging              Stored Procedures
    Event Handlers              Rate Limiting                  Indexes
```

### Technology Stack

- **Bot:** Discord.js 14 (Node.js 18+)
- **Backend:** Fastify (Node.js 18+)
- **Database:** PostgreSQL 14+
- **Validation:** Zod (both bot and backend)
- **Container:** Docker + Docker Compose
- **TypeScript:** 5.x with strict mode

---

## Component Architecture

### Discord Bot

**Location:** `bot/src/`

**Responsibilities:**
- Handle Discord events (ready, interactionCreate, messageCreate)
- Register and execute slash commands
- Manage button/modal interactions
- Maintain local state (run sessions, modmail tickets)
- Schedule periodic tasks
- Call backend API for data persistence

**Entry Point:** [bot/src/index.ts](../bot/src/index.ts)

**Key modules:**
- [commands/](../bot/src/commands/) — All slash commands organized by category
- [interactions/](../bot/src/interactions/) — Button/modal handlers
- [lib/tasks/](../bot/src/lib/tasks/) — Scheduled background tasks
- [services/](../bot/src/services/) — External integrations (RealmEye)
- [lib/state/](../bot/src/lib/state/) — In-memory state management

**Command Structure:**

```typescript
// bot/src/commands/_types.ts
export type SlashCommand = {
  data: SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder | SlashCommandOptionsOnlyBuilder;
  run: (interaction: ChatInputCommandInteraction) => Promise<void>;
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
  requiredRole?: RoleKey | RoleKey[];
  mutatesRoles?: boolean; // Enforces bot role position check before execution
};
```

All commands follow this interface and are auto-registered in [commands/index.ts](../bot/src/commands/index.ts).

**Event Flow:**

```
Discord User Action
        ↓
interactionCreate event
        ↓
Command Router (index.ts)
        ↓
Permission Check (lib/permissions/)
        ↓
Command Handler (commands/*)
        ↓
Backend API Call (if data needed)
        ↓
Update Discord UI (reply/edit)
```

### Backend API

**Location:** `backend/src/`

**Responsibilities:**
- Expose REST API for bot to consume
- Authenticate requests (shared API key)
- Validate all inputs with Zod
- Execute database queries via connection pool
- Log all actions to audit table

**Entry Point:** [backend/src/server.ts](../backend/src/server.ts)

**Key modules:**
- [routes/](../backend/src/routes/) — API endpoints organized by domain
- [lib/database/](../backend/src/lib/database/) — Database query functions
- [lib/auth/](../backend/src/lib/auth/) — JWT validation and API key checks
- [lib/validation/](../backend/src/lib/validation/) — Zod schemas
- [plugins/](../backend/src/plugins/) — Fastify plugins (auth, logging)

**API Structure:**

```typescript
// Example route definition
fastify.post('/guilds/:guildId/raiders', {
  schema: {
    params: z.object({ guildId: z.string() }),
    body: createRaiderSchema,
    response: { 200: raiderSchema }
  },
  preHandler: [authenticateRequest],
}, async (request, reply) => {
  // Handler logic
});
```

**Request Flow:**

```
Bot HTTP Request
        ↓
Fastify Router
        ↓
Auth Plugin (verify x-api-key header)
        ↓
Validation (Zod schemas)
        ↓
Route Handler
        ↓
Database Query
        ↓
Response (JSON)
        ↓
Bot Processes Response
```

### Database

**Location:** `backend/src/db/`

**Technology:** PostgreSQL 14+ with pg connection pool

**Schema Management:**
- Sequential numbered migrations: `001_init.sql` → `058_bot_bait_channel.sql`
- Auto-run on backend startup via [scripts/migrate.ts](../backend/src/scripts/migrate.ts)
- Versioned in `schema_migrations` table

**Key Tables:**

| Table | Purpose |
|-------|---------|
| `guilds` | Discord guild configuration |
| `guild_roles` | Internal role mappings |
| `guild_channels` | Internal channel mappings |
| `raiders` | Verified member records |
| `raider_alts` | Alternate IGNs |
| `runs` | Active and historical raid runs |
| `run_raiders` | Participants in runs |
| `headcounts` | Headcount sessions |
| `keys_tracking` | Key pops per dungeon |
| `quota_events` | Quota point transactions |
| `raider_points` | Raider participation points |
| `punishments` | Warnings, suspensions, mutes, etc. |
| `notes` | Staff notes on members |
| `modmail_tickets` | Support ticket threads |
| `verification_sessions` | Active verification flows |
| `command_log` | All bot command executions |

**Indexes:**
- Primary keys on all tables
- Foreign keys with cascading deletes
- Performance indexes on frequently queried columns (see `045_performance_indexes.sql`)

**Connection Pool:**

```typescript
// backend/src/db/pool.ts
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // Single connection string
  max: 10,                   // Maximum connections in pool
  idleTimeoutMillis: 30000,  // Release idle connections after 30s
  connectionTimeoutMillis: 5000, // Fail fast if pool exhausted
});
```

---

## Permission System

### Role Hierarchy

Permissions cascade from highest to lowest:

```
administrator
    ↓
moderator
    ↓
head_organizer
    ↓
officer
    ↓
security
    ↓
organizer
    ↓
team
    ↓
verified_raider
```

**Implementation:**

```typescript
// bot/src/lib/permissions/permissions.ts
const ROLE_HIERARCHY: RoleKey[] = [
  'verified_raider',
  'organizer',
  'security',
  'officer',
  'head_organizer',
  'moderator',
  'administrator',
];
// Higher index = higher authority.
// A user holding a role at index N can execute commands requiring any role at index ≤ N.
```

### Command Authorization

**Two-layer check:**

1. **Command-level:** `requiredRole` in command definition
2. **Target-level:** `canActorTargetMember()` for moderation commands

**Example:**

```typescript
// Command requires Security role
export const warn: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Issue a warning'),
  requiredRole: 'security',
  async run(interaction) {
    // canActorTargetMember() prevents targeting equal/higher roles
    // Permission middleware applied in commands/index.ts via withMiddleware()
  }
};
```

### Backend Authorization

The backend authenticates every request using a **shared API key** (`BACKEND_API_KEY`) passed in the `x-api-key` request header. This is a server-to-server secret set in both `.env` files and checked by the auth Fastify plugin.

```typescript
// backend/src/plugins/auth.ts (simplified)
fastify.addHook('onRequest', async (req, reply) => {
  const headerKey = req.headers['x-api-key'];
  if (!headerKey || headerKey !== backendConfig.BACKEND_API_KEY) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }
});
```

Rate limiting for sensitive commands (e.g., `/purge`) is applied **in the bot** via middleware in `bot/src/lib/utilities/rate-limit-middleware.ts`.

---

## State Management

### Bot-Side State

**In-memory storage** for ephemeral data:

```typescript
// bot/src/lib/state/runs.ts
const activeRuns = new Map<string, RunSession>();

export function getRunSession(messageId: string): RunSession | undefined {
  return activeRuns.get(messageId);
}

export function setRunSession(messageId: string, session: RunSession): void {
  activeRuns.set(messageId, session);
}
```

**Stored in memory:**
- Active headcount sessions (dungeon, participant counts, organizer)
- Modmail ticket state (guild selection, message content)
- Verification sessions (IGN, method, verification code — also persisted to DB)
- Party finder posts (per-user active party tracking)

**Persisted to database:**
- Completed runs
- Final raider participation
- Verification results
- Modmail transcripts

### Database State

**Source of truth** for all persistent data.

**Transactions** used for multi-step operations:

```typescript
// backend/src/lib/database/runs.ts
export async function createRun(guildId: string, data: CreateRunData) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Insert run
    const runResult = await client.query(
      'INSERT INTO runs (...) VALUES (...) RETURNING id',
      [...]
    );
    
    // Award quota to organizer
    await client.query(
      'INSERT INTO quota_events (...) VALUES (...)',
      [...]
    );
    
    await client.query('COMMIT');
    return runResult.rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
```

---

## Scheduled Tasks

### Implementation

Tasks are registered in `bot/src/lib/tasks/scheduled-tasks.ts` and run via `setInterval`. The scheduler wraps each handler in error isolation so a failing task never crashes the process.

```typescript
// bot/src/lib/tasks/scheduled-tasks.ts (simplified)
const tasks: TaskConfig[] = [
  { name: 'Expired Runs',           intervalMinutes: 5,  handler: checkExpiredRuns },
  { name: 'Expired Headcounts',     intervalMinutes: 5,  handler: checkExpiredHeadcounts },
  { name: 'Expired Punishments',    intervalMinutes: 2,  handler: checkExpiredPunishments },
  { name: 'Expired Verification',   intervalMinutes: 5,  handler: checkExpiredVerificationSessions },
  { name: 'Orphaned Run Roles',     intervalMinutes: 15, handler: cleanupOrphanedRunRoles },
  { name: 'Quota Panel Updates',    intervalMinutes: 10, handler: updateQuotaPanels },
];

export function startScheduledTasks(client: Client) {
  for (const task of tasks) {
    const wrapped = wrapTaskHandler(task);
    setInterval(() => wrapped(client), task.intervalMinutes * 60_000);
  }
}
```

### Active Tasks

**1. Expired Runs Checker** — every 5 minutes
Auto-ends runs that have exceeded their `auto_end_minutes` duration. Queries the backend for expired run IDs, ends them via API, deletes the temporary run role and ping message in Discord, and updates the run embed.

**2. Expired Headcounts Checker** — every 5 minutes
Expires in-memory headcounts that have exceeded their timeout. Edits the Discord message to show the headcount ended, then clears all in-memory state.

**3. Expired Punishments Checker** — every 2 minutes
Removes `suspended` and `muted` Discord roles from members whose punishment duration has elapsed, marks the punishment as expired in the backend, and logs to the `punishment_log` channel.

**4. Expired Verification Sessions** — every 5 minutes
Calls the backend to clean up stale verification sessions that members abandoned.

**5. Orphaned Run Roles Cleanup** — every 15 minutes
Deletes Discord roles matching the run-role naming pattern that are no longer associated with any active run (e.g., from a bot restart mid-run).

**6. Quota Panel Updates** — every 10 minutes
Refreshes quota leaderboard embeds in configured `quota` channels with current point totals.

---

## Logging & Audit

### Command Logging

**Every command logged to database:**

```typescript
// bot/src/lib/logging/command-log.ts
export async function logCommand(
  interaction: CommandInteraction,
  success: boolean,
  error?: string
) {
  await backend.post('/command-log', {
    guildId: interaction.guildId,
    userId: interaction.user.id,
    command: interaction.commandName,
    options: JSON.stringify(interaction.options.data),
    success,
    error,
    timestamp: new Date().toISOString(),
  });
}
```

**Table:** `command_log`

**Retention:** Indefinite (archive old entries periodically)

### Action Logging

**Domain-specific logs to Discord channels:**

| Log Type | Channel Mapping | Events |
|----------|----------------|--------|
| Bot logs | `bot_log` | Command executions, errors, startup |
| Punishment logs | `punishment_log` | Warns, suspensions, mutes, kicks, bans, expirations |
| Verification logs | `veri_log` | Verifications, unverifications, IGN changes |
| Raid logs | `raid_log` | Run creation, status changes |
| Staff updates | `staff_updates` | Role promotions/demotions |

**Implementation:**

```typescript
// bot/src/lib/logging/discord-log.ts
export async function logToChannel(
  guild: Guild,
  channelType: ChannelType,
  embed: EmbedBuilder
) {
  const channelId = await getChannelMapping(guild.id, channelType);
  if (!channelId) return; // Log channel not configured
  
  const channel = await guild.channels.fetch(channelId);
  if (channel?.isTextBased()) {
    await channel.send({ embeds: [embed] });
  }
}
```

### Error Handling

**Graceful degradation:**

```typescript
try {
  await executeCommand(interaction);
} catch (error) {
  logger.error('Command execution failed', { error, interaction });
  
  await interaction.reply({
    content: 'An error occurred. Staff have been notified.',
    ephemeral: true,
  });
  
  await logToChannel(guild, 'bot_log', errorEmbed(error));
}
```

**Never crash bot** — catch all errors, log, and inform user gracefully.

---

## Database Migrations

### Migration System

**Sequential numbered files** in `backend/src/db/migrations/`:

```
001_init.sql               — Initial schema (guild, member, raider, run, reaction, audit)
002_contract_safety.sql    — Add contract safety features
...
058_bot_bait_channel.sql   — Add bot-bait channel mapping
```

**Migration runner:**

```typescript
// backend/src/scripts/migrate.ts
export async function runMigrations() {
  const client = await pool.connect();
  
  try {
    // Create migrations table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Get applied migrations
    const applied = await client.query(
      'SELECT version FROM schema_migrations ORDER BY version'
    );
    const appliedVersions = new Set(applied.rows.map(r => r.version));
    
    // Get migration files
    const migrationFiles = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();
    
    // Apply new migrations
    for (const file of migrationFiles) {
      const version = parseInt(file.split('_')[0]);
      
      if (!appliedVersions.has(version)) {
        console.log(`Applying migration ${version}: ${file}`);
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version) VALUES ($1)',
          [version]
        );
        await client.query('COMMIT');
        
        console.log(`✓ Applied migration ${version}`);
      }
    }
    
    console.log('All migrations up to date');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
```

**Auto-run on startup** in [backend/src/server.ts](../backend/src/server.ts):

```typescript
async function start() {
  await runMigrations();
  await fastify.listen({ port: 3000, host: '0.0.0.0' });
}
```

### Writing Migrations

**Naming convention:** `XXX_description.sql` where XXX is next sequential number.

**Best practices:**

1. **Idempotent** — Use `IF NOT EXISTS`, `IF EXISTS`
2. **Forward-only** — No rollback migrations (handle in new forward migration)
3. **Transactional** — Each migration runs in single transaction
4. **Test locally** — Apply to dev database first

**Example migration:**

```sql
-- 035_add_raider_notes.sql

-- Add notes column to raiders table
ALTER TABLE raiders
ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT NULL;

-- Create index for fast lookups
CREATE INDEX IF NOT EXISTS idx_raiders_notes 
ON raiders(guild_id, discord_id) 
WHERE notes IS NOT NULL;

-- Log migration
INSERT INTO migration_log (version, description, applied_at)
VALUES (35, 'Add raider notes column', NOW());
```

---

## Development Setup

### Prerequisites

- **Node.js:** 18.x or higher
- **PostgreSQL:** 14.x or higher
- **Docker:** 20.x or higher (optional, for containerized setup)
- **pnpm/npm/yarn:** Package manager

### Local Development (Without Docker)

**1. Clone repository:**

```bash
git clone https://github.com/your-org/rotmg-raid-bot.git
cd rotmg-raid-bot
```

**2. Install dependencies:**

```bash
cd backend && npm install
cd ../bot && npm install
```

**3. Configure environment:**

```bash
# backend/.env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=rotmg_bot
DB_USER=postgres
DB_PASSWORD=yourpassword
JWT_SECRET=your-jwt-secret
API_KEY=your-api-key-for-bot

# bot/.env
DISCORD_TOKEN=your-bot-token
DISCORD_CLIENT_ID=your-client-id
BACKEND_URL=http://localhost:3000
BACKEND_API_KEY=your-api-key-for-bot
```

**4. Set up database:**

```bash
createdb rotmg_bot
psql rotmg_bot < backend/src/db/migrations/*.sql
```

**5. Start backend:**

```bash
cd backend
npm run dev
```

**6. Register commands:**

```bash
cd bot
npm run register-commands
```

**7. Start bot:**

```bash
npm run dev
```

### Docker Development

**1. Configure environment:**

```bash
cp .env.example .env
# Edit .env with your Discord credentials
```

**2. Start services:**

```bash
docker-compose up -d
```

**3. View logs:**

```bash
docker-compose logs -f bot
docker-compose logs -f backend
```

**4. Rebuild after code changes:**

```bash
docker-compose up -d --build
```

### Testing

**Unit tests:**

```bash
cd backend
npm test

cd bot
npm test
```

**Integration tests:**

```bash
# Start test database
docker-compose -f docker-compose.test.yml up -d

# Run integration tests
npm run test:integration
```

**Manual testing:**

1. Create test Discord server
2. Invite bot to test server
3. Run `/setroles` and `/setchannels` to configure
4. Test commands manually

---

## Deployment

### Production Setup

**Docker Compose (recommended):**

```yaml
# docker-compose.yml
version: '3.8'

services:
  postgres:
    image: postgres:14
    environment:
      POSTGRES_DB: rotmg_bot
      POSTGRES_USER: botuser
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "botuser"]
      interval: 10s
      timeout: 5s
      retries: 5

  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile
    environment:
      DB_HOST: postgres
      DB_PORT: 5432
      DB_NAME: rotmg_bot
      DB_USER: botuser
      DB_PASSWORD: ${DB_PASSWORD}
      JWT_SECRET: ${JWT_SECRET}
      API_KEY: ${API_KEY}
    depends_on:
      postgres:
        condition: service_healthy
    ports:
      - "3000:3000"

  bot:
    build:
      context: ./bot
      dockerfile: Dockerfile
    environment:
      DISCORD_TOKEN: ${DISCORD_TOKEN}
      DISCORD_CLIENT_ID: ${DISCORD_CLIENT_ID}
      BACKEND_URL: http://backend:3000
      BACKEND_API_KEY: ${API_KEY}
    depends_on:
      - backend

volumes:
  postgres_data:
```

**Start production:**

```bash
docker-compose up -d
```

### Environment Variables

**Required for bot:**
- `DISCORD_TOKEN` — Bot token from Discord Developer Portal
- `DISCORD_CLIENT_ID` — Application ID
- `BACKEND_URL` — Backend API URL
- `BACKEND_API_KEY` — Shared secret for bot↔backend auth

**Required for backend:**
- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` — Database credentials
- `JWT_SECRET` — Secret for signing JWT tokens
- `API_KEY` — Shared secret for bot authentication

**Optional:**
- `NODE_ENV` — `production` or `development`
- `LOG_LEVEL` — `debug`, `info`, `warn`, `error`

### Monitoring

**Health checks:**

```bash
# Backend health endpoint
curl http://localhost:3000/health

# Bot status (check Docker logs)
docker logs rotmg-bot | tail -n 50
```

**Database backups:**

```bash
# Automated daily backup
docker exec postgres pg_dump -U botuser rotmg_bot > backup-$(date +%Y%m%d).sql
```

**Log rotation:**

Configure Docker logging driver:

```yaml
services:
  bot:
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

---

## Code Organization

### Backend Structure

```
backend/src/
├── config.ts              — Environment config
├── server.ts              — Fastify server entry
├── db/
│   ├── pool.ts            — PostgreSQL connection pool
│   └── migrations/        — Database schema migrations
├── lib/
│   ├── auth/              — JWT + API key authentication
│   ├── database/          — Query functions by domain
│   ├── errors/            — Custom error classes
│   ├── logging/           — Logging utilities
│   ├── permissions/       — Role hierarchy checks
│   ├── quota/             — Quota calculation logic
│   ├── services/          — External service integrations
│   └── validation/        — Zod schemas
├── plugins/
│   └── auth.ts            — Fastify auth plugin
└── routes/
    ├── guilds.ts          — Guild configuration endpoints
    ├── admin/             — Admin-only endpoints
    ├── moderation/        — Punishment management
    ├── raid/              — Run management
    └── system/            — Health checks, status
```

### Bot Structure

```
bot/src/
├── config.ts              — Environment config
├── index.ts               — Bot entry point
├── register-commands.ts   — Command registration script
├── commands/
│   ├── _types.ts          — Command interface
│   ├── index.ts           — Command loader
│   ├── help.ts            — Help command
│   ├── configs/           — Configuration commands
│   ├── moderation/        — Moderation commands
│   └── organizer/         — Organizer commands
├── config/
│   └── raid-config.ts     — Raid configuration constants
├── constants/
│   ├── classes.ts         — ROTMG class definitions
│   └── dungeons/          — Dungeon metadata
├── interactions/
│   └── buttons/           — Button interaction handlers
├── lib/
│   ├── errors/            — Custom error classes
│   ├── logging/           — Discord + database logging
│   ├── modmail/           — Modmail state management
│   ├── permissions/       — Role hierarchy + checks
│   ├── state/             — In-memory state (runs, headcounts)
│   ├── tasks/             — Scheduled background tasks
│   ├── team/              — Team role synchronization
│   ├── ui/                — Embed/button builders
│   ├── utilities/         — Helper functions
│   ├── validation/        — Input validation
│   └── verification/      — Verification flow handlers
├── scripts/
│   └── test-realmeye.ts   — RealmEye API testing
└── services/
    └── realmeye/          — RealmEye integration
```

---

## Adding New Features

### New Slash Command

**1. Create command file:**

```typescript
// bot/src/commands/category/mycommand.ts
import { SlashCommandBuilder } from 'discord.js';
import type { Command } from '../_types';

export const myCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('mycommand')
    .setDescription('Does something cool')
    .addStringOption(option =>
      option.setName('input')
        .setDescription('Input parameter')
        .setRequired(true)
    ),
  requiredRole: 'organizer', // Optional
  async execute(interaction) {
    const input = interaction.options.getString('input', true);
    
    // Implementation
    await interaction.reply(`You said: ${input}`);
  },
};
```

**2. Export from index:**

```typescript
// bot/src/commands/index.ts
export { myCommand } from './category/mycommand';
```

**3. Register command:**

```bash
npm run register-commands
```

**4. Test in Discord:**

```
/mycommand input:test
```

### New Database Table

**1. Create migration:**

```sql
-- backend/src/db/migrations/036_add_my_table.sql

CREATE TABLE IF NOT EXISTS my_table (
  id SERIAL PRIMARY KEY,
  guild_id VARCHAR(20) NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
);

CREATE INDEX idx_my_table_guild ON my_table(guild_id);
```

**2. Create query functions:**

```typescript
// backend/src/lib/database/my-table.ts
import { pool } from '../../db/pool';

export async function createEntry(guildId: string, data: any) {
  const result = await pool.query(
    'INSERT INTO my_table (guild_id, data) VALUES ($1, $2) RETURNING *',
    [guildId, JSON.stringify(data)]
  );
  return result.rows[0];
}

export async function getEntry(id: number) {
  const result = await pool.query(
    'SELECT * FROM my_table WHERE id = $1',
    [id]
  );
  return result.rows[0];
}
```

**3. Create API endpoint:**

```typescript
// backend/src/routes/my-routes.ts
export async function myRoutes(fastify: FastifyInstance) {
  fastify.post('/my-table', {
    preHandler: [authenticateRequest],
  }, async (request, reply) => {
    const entry = await createEntry(request.body.guildId, request.body.data);
    return entry;
  });
  
  fastify.get('/my-table/:id', async (request, reply) => {
    const entry = await getEntry(request.params.id);
    return entry;
  });
}
```

**4. Call from bot:**

```typescript
const entry = await backend.post('/my-table', {
  guildId: interaction.guildId,
  data: { ... },
});
```

### New Scheduled Task

**1. Create task file:**

```typescript
// bot/src/lib/tasks/my-task.ts
import { backend } from '../utilities/backend-client';

export async function myScheduledTask() {
  console.log('Running my scheduled task');
  
  try {
    const data = await backend.get('/my-endpoint');
    
    // Process data
    for (const item of data) {
      // Do something
    }
  } catch (error) {
    console.error('My task failed:', error);
  }
}
```

**2. Register task:**

```typescript
// bot/src/lib/tasks/index.ts
import { myScheduledTask } from './my-task';

export function startScheduledTasks() {
  // Every hour
  schedule.scheduleJob('0 * * * *', myScheduledTask);
}
```

**3. Test manually:**

```typescript
// bot/src/scripts/test-my-task.ts
import { myScheduledTask } from '../lib/tasks/my-task';

myScheduledTask().then(() => {
  console.log('Task completed');
  process.exit(0);
});
```

---

## Common Patterns

### Embed Builder

**Reusable embed templates:**

```typescript
// bot/src/lib/ui/embeds.ts
export function successEmbed(title: string, description: string) {
  return new EmbedBuilder()
    .setColor(0x00ff00)
    .setTitle(`✅ ${title}`)
    .setDescription(description)
    .setTimestamp();
}

export function errorEmbed(error: string) {
  return new EmbedBuilder()
    .setColor(0xff0000)
    .setTitle('❌ Error')
    .setDescription(error)
    .setTimestamp();
}
```

### Button Interactions

**Custom ID format:** `action:param1:param2`

```typescript
// Create button
const button = new ButtonBuilder()
  .setCustomId(`approve_run:${runId}:${organizerId}`)
  .setLabel('Approve')
  .setStyle(ButtonStyle.Success);

// Handle button click
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  
  const [action, runId, organizerId] = interaction.customId.split(':');
  
  if (action === 'approve_run') {
    await approveRun(runId);
    await interaction.update({ components: [] }); // Remove buttons
  }
});
```

### Error Handling

**Consistent error responses:**

```typescript
try {
  await riskyOperation();
} catch (error) {
  if (error instanceof ValidationError) {
    return interaction.reply({
      embeds: [errorEmbed(error.message)],
      ephemeral: true,
    });
  }
  
  // Unexpected error
  logger.error('Unexpected error', { error });
  return interaction.reply({
    embeds: [errorEmbed('An unexpected error occurred. Please try again.')],
    ephemeral: true,
  });
}
```

---

## Troubleshooting Development

### Bot won't start

**Check:**
- `.env` file has all required variables
- Discord token is valid (test in Developer Portal)
- Backend is running and accessible
- Database is accessible

**Fix:**
- Verify environment variables
- Check Docker logs: `docker-compose logs bot`
- Test backend health: `curl http://localhost:3000/health`

### Commands not appearing

**Cause:** Commands not registered or registration failed.

**Fix:**

```bash
cd bot
npm run register-commands
```

**Check registration output** for errors.

### Database migrations failing

**Check:**
- PostgreSQL is running
- Database user has CREATE permissions
- No syntax errors in migration SQL

**Fix:**

```bash
# Manually apply migration
psql rotmg_bot < backend/src/db/migrations/XXX_migration.sql

# Or reset database (development only!)
dropdb rotmg_bot
createdb rotmg_bot
npm run migrate
```

### Backend 401 Unauthorized

**Cause:** API key mismatch between bot and backend.

**Fix:**
- Ensure `BACKEND_API_KEY` in bot `.env` matches `API_KEY` in backend `.env`
- Restart both services after changing

### TypeScript errors

**Common issues:**
- Missing type definitions: `npm install -D @types/package-name`
- Import path issues: Check `tsconfig.json` paths
- Strict mode violations: Fix type assertions

**Build before running:**

```bash
npm run build
npm start
```

---

## Performance Considerations

### Database Queries

**Use indexes** for frequently queried columns:

```sql
CREATE INDEX idx_runs_status ON runs(status, guild_id);
```

**Avoid N+1 queries** — fetch related data in single query:

```sql
-- Bad: N+1 query
SELECT * FROM runs WHERE guild_id = $1; -- 1 query
-- Then for each run:
SELECT * FROM run_raiders WHERE run_id = $1; -- N queries

-- Good: Single join
SELECT r.*, rr.* 
FROM runs r
LEFT JOIN run_raiders rr ON r.id = rr.run_id
WHERE r.guild_id = $1;
```

### Bot Memory

**Clear expired sessions periodically:**

```typescript
// bot/src/lib/state/cleanup.ts
setInterval(() => {
  const now = Date.now();
  
  for (const [key, session] of activeRuns) {
    if (now - session.createdAt > 2 * 60 * 60 * 1000) { // 2 hours
      activeRuns.delete(key);
    }
  }
}, 10 * 60 * 1000); // Every 10 minutes
```

### API Rate Limits

**Discord API:**
- 50 requests per second per bot
- Use rate limit headers to back off

**Backend API:**
- Implement rate limiting per user
- Use connection pooling for database

---

## Security Best Practices

### Environment Variables

**Never commit** `.env` files — add to `.gitignore`:

```gitignore
.env
.env.local
.env.production
```

**Use secrets management** in production (AWS Secrets Manager, HashiCorp Vault, etc.)

### Input Validation

**Always validate user input** with Zod:

```typescript
const schema = z.object({
  ign: z.string().min(1).max(16).regex(/^[a-zA-Z0-9]+$/),
  duration: z.string().regex(/^\d+(m|h|d)$/),
});

const result = schema.safeParse(input);
if (!result.success) {
  throw new ValidationError('Invalid input');
}
```

### SQL Injection Prevention

**Always use parameterized queries:**

```typescript
// ✅ Safe
await pool.query('SELECT * FROM raiders WHERE ign = $1', [ign]);

// ❌ Vulnerable
await pool.query(`SELECT * FROM raiders WHERE ign = '${ign}'`);
```

### Permission Checks

**Verify permissions on every action:**

```typescript
if (!hasRequiredRole(interaction.member, 'security')) {
  return interaction.reply('Insufficient permissions');
}
```

---

## Contributing Guidelines

### Code Style

- **TypeScript strict mode** enabled
- **ESLint** configured in both bot and backend
- **Prettier** for consistent formatting

**Run linter:**

```bash
npm run lint
```

### Git Workflow

**1. Create feature branch:**

```bash
git checkout -b feature/my-feature
```

**2. Make changes and commit:**

```bash
git add .
git commit -m "feat: add my feature"
```

**3. Push and create pull request:**

```bash
git push origin feature/my-feature
```

**4. Code review and merge**

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation changes
- `refactor:` Code restructuring
- `test:` Test additions/changes
- `chore:` Maintenance tasks

---

## Further Reading

- **[Setup Guide](setup.md)** — Installation and configuration
- **[Raid Management](raid-management.md)** — Run creation and party finder
- **[Quota System](quota-system.md)** — Points and leaderboards
- **[Verification](verification.md)** — Member verification flows
- **[Moderation](moderation.md)** — Punishment system and modmail

---

## Summary

**System Architecture:**
- Discord.js bot + Fastify backend + PostgreSQL database
- Bot handles commands, backend manages data, database stores state
- JWT authentication between bot and backend
- Role-based permission hierarchy with 8 levels
- Scheduled tasks for auto-expiration and maintenance

**Development Setup:**
- Node.js 18+, PostgreSQL 14+, Docker (optional)
- Environment variables for configuration
- Sequential database migrations auto-run on startup
- TypeScript with strict mode throughout

**Key Patterns:**
- Command interface with `data`, `requiredRole`, `execute`
- In-memory state for ephemeral data, database for persistence
- Embed builders for consistent UI
- Button custom IDs: `action:param1:param2`
- Transaction-based multi-step operations

**Contributing:**
- Feature branches with descriptive names
- Conventional commit messages
- ESLint + Prettier for code quality
- Test locally before creating PR

For questions, refer to inline code documentation or ask in the development channel.
