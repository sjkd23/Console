# AI Agent Survival Guide: RotMG Raid Bot

**STOP.** Read this before generating code.
This is a production TypeScript repo. We use strict mode. We use Zod. We don't guess.

---

## 1. The Golden Rules (How to not break things)

1.  **Strict Types Only:** No `any`. Prefer `unknown` + Zod parsing if you are unsure. If you can't type it, don't write it.
2.  **Zod Everything:** Input from Discord? Zod. Input from API? Zod. Env vars? Zod.
3.  **Split Brain Architecture:**
    *   **Bot** (`/bot`) handles UI, Interactions, and Discord Events.
    *   **Backend** (`/backend`) handles Data, Business Logic, and State.
    *   *Do not put complex business logic in the bot. Call the API.*
4.  **Database is Law:**
    *   Use **Parameterized Queries** (`$1`, `$2`). String concatenation in SQL is an immediate fail.
    *   **Migrations** are sequential and forward-only. Never edit an existing migration file. Create a new one.
    *   If you change the DB schema, update indexes and queries accordingly.
5.  **Permissions:**
    *   **Hierarchy is Hardcoded:** The order (`administrator` > `moderator` > ...) is defined in `bot/src/lib/permissions/permissions.ts`.
    *   **Mappings are Configurable:** Discord roles are mapped to internal roles per-guild via `/setroles`.

---

## 2. Critical Patterns (Copy These)

### Creating a Command
Don't reinvent the wheel. Use the `SlashCommand` interface.
```typescript
// bot/src/commands/_types.ts
export const myCommand: SlashCommand = {
  data: new SlashCommandBuilder().setName('foo').setDescription('bar'),
  requiredRole: 'organizer', // <--- CRITICAL: Enforces permission hierarchy
  async run(interaction) {
    // Logic here
  }
};
```

### Calling the Backend
The bot talks to the backend via a shared secret. Use the helper functions.
```typescript
// Check bot/src/lib/utilities/http.ts for available exports
import { postJSON, getJSON } from '../../lib/utilities/http.js';

// Good
const data = await postJSON('/runs', { ...payload });

// Bad
fetch(`${process.env.BACKEND_URL}/runs`, ...); // Don't do this manually
```

### Database Queries
```typescript
// backend/src/lib/database/some-file.ts
// Good
await query('SELECT * FROM users WHERE id = $1', [userId]);

// Bad
await query(`SELECT * FROM users WHERE id = ${userId}`); // SQL Injection risk
```

---

## 3. The Danger Zones

*   **State Management:**
    *   **Ephemeral:** Active runs, headcounts, and verification sessions live in **Memory**. If the bot restarts, they die.
    *   **Persistent:** User profiles, points, quotas, logs live in **Postgres**.
*   **Verification:** This is complex. It involves **RealmEye + Screenshots + Manual Review**. Touch `bot/src/lib/verification` with extreme caution.
*   **Quota System:** Points are calculated dynamically based on config. Changing `quota_config` affects live leaderboards immediately.
*   **Migrations:** Live in `backend/src/db/migrations/`. They run on backend start.

---

## 4. Where Things Live

| Concept | Path | Note |
| :--- | :--- | :--- |
| **Commands** | `bot/src/commands/` | Register in `index.ts` after creating. |
| **API Routes** | `backend/src/routes/` | Fastify plugins. |
| **DB Schema** | `backend/src/db/migrations/` | SQL files. 001, 002, etc. |
| **Permissions** | `bot/src/lib/permissions/` | The "who can do what" logic. |
| **Config** | `bot/src/config/raid-config.ts` | Constants for raid behavior. |

---

## 5. Development Workflow

1.  **Migrations:** `npm run migrate` in `backend/`.
2.  **Commands:** `npm run register:dev` in `bot/` if you change names/options. Production uses the compiled `npm run register` entrypoint.
3.  **Docker:** `docker compose -f docker-compose.yml -f docker-compose.dev.yml up` runs the local development stack. Plain `docker compose up -d` is the production deployment path.
4.  **Logs:** Check `docker compose logs -f backend` if the API fails.

---

## 6. Output Expectations

*   **Full Files:** When editing, provide the full file content unless asked for a diff.
*   **Public APIs:** Don't change public APIs without noting it.
*   **Migrations:** Call out any migration needed for your changes.

---

**Final Warning:** If you are unsure about a pattern, read an existing file in `bot/src/commands/organizer/` or `backend/src/routes/raid/`. Mimic existing code. Do not introduce new architectural patterns.
