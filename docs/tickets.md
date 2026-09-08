# Configurable Console tickets

## Architecture and commands

The backend owns ticket configuration, guild authorization, reservations, transitions, history and the transcript outbox. The bot owns Discord interactions, channel/message/thread operations, the interactive builder and compensation for failed Discord operations. All bot persistence uses the existing shared-secret HTTP helper; the bot never connects to PostgreSQL.

Four guild-only Moderator+ commands are registered through the existing command middleware:

| Command | Behavior |
| --- | --- |
| `/createticket` | Opens an ephemeral interactive ticket-type builder, with no embed-property slash options. |
| `/editticket ticket:` | Guild-scoped autocomplete restores a persisted configuration and its canonical panel tracking. |
| `/listtickets page:` | Lists type, panel channel, category, enabled state and publication state; paginated 25 per page, split into Discord-safe messages. |
| `/deleteticket ticket:` | Opens an explicit disable confirmation. Disables new creation before removing the canonical panel. |

Type names need not be unique. Autocomplete includes a short configuration ID to distinguish similar names. The persisted UUID defines the ticket type.

## Builder and shared embed editor

The builder has a purpose modal, native text-channel selector, native category selector and optional native staff-role selector (up to 20 additional roles). Its general controls are **Edit Panel Embed**, **Edit Opening Embed**, **Save Changes**, and **Publish / Move**. Required configuration is validated before saving. Publication is a separate explicit action.

Type, destination, category, publication status, current editing target and canonical-message link appear outside the configurable preview. The two embed previews toggle in place; edits update the existing ephemeral builder message. Each embed editor shows a disabled Create Ticket or Close Ticket preview button. Preview IDs use the builder namespace and cannot reach production ticket actions.

Both templates are independent structured configurations owned by the ticket type. They reuse:

- `embeds/contract.ts`: the same Zod schema, URL/color rules, per-property limits and aggregate 6000-character validation.
- `embeds/render.ts`: the same Discord renderer.
- `embeds/ui.ts`: the existing property selector, property modals and field-management components.
- `embeds/editing.ts`: extracted shared modal and field mutations, now used by both saved embeds and tickets.
- `embeds/session.ts`: draft validation, expiry, revision and editor-state conventions.

Title, description, color, footer/icon, media, thumbnail, author, title URL, timestamp, field contents, field order and inline state use the existing tooling. The existing description editor's 4000-character modal limit remains; central validation still accepts existing 4096-character descriptions. Saved-embed canonical publication records are never used or changed by tickets. Importing a saved embed is not included; it was optional.

Builders enforce current Moderator+ authorization on every action, owner/guild/message identity, stale-revision rejection, a busy guard, 30-minute inactivity expiry and session limits. Existing opening messages are never edited when the opening template changes: future tickets use the updated template.

## Database and API

**077_tickets.sql** adds:

- `ticket_config`: UUID, guild, display name, desired panel destination, category, structured panel/opening embeds, additional role IDs, enabled state, canonical channel/message pair, creator, timestamps and revision.
- `ticket`: UUID, guild/config/user IDs, type-name and effective staff-role snapshots, source channel, root-log channel/message, transcript thread, opening-message ID, lifecycle state, operation UUID/lease, timestamps and closing actor.
- A composite guild/config foreign key preserves guild ownership and prevents deletion of referenced configurations.
- A partial unique index on `(guild_id, ticket_config_id, user_id)` for **creating, open and closing** states. Closed/failed/stale rows remain historical and do not block replacements.
- Indexes for guild configuration lists, active-ticket recovery and unique channel/thread/panel references.

**078_ticket_transcript_outbox.sql** adds `ticket_transcript_event`, with a ticket/event key, ordered text chunks and delivered-chunk cursor. Private audit content is queued until accepted by Discord. SQL calls redact content parameters from application logging.

The additive authenticated API is `POST /v1/guilds/:guild_id/tickets/:action`. Actions are `list`, `get`, `save`, `claim`, `publication`, `disable`, `reserve`, `ticket`, `active`, `checkpoint`, `close`, `recover`, `enqueue`, `pending`, and `ack`. Configuration actions require Moderator+ or Discord Administrator. Ordinary closure also checks creator/effective ticket roles in the backend. Internal recovery/outbox actions are trusted bot operations protected by the existing API key. These are not public browser endpoints.

Discord resources are freshly fetched through the actual guild in the bot, including roles and channel types. The backend validates the authenticated bot's resolved-resource envelope against the route guild, desired channel/category IDs and every selected role. `@everyone` cannot be configured as ticket staff. The backend has no Discord token and follows the existing trusted-bot actor/resource boundary rather than accepting resources directly from end-user custom IDs. A supplied HTTP guild-context header must also match the route guild.

## Panel publication

Each configuration has one canonical published channel/message pair, separate from the desired destination. Saving persists configuration with a revision check and edits the same canonical message, preserving its Create Ticket button. Saving never sends a replacement panel.

A missing canonical message/channel clears stale tracking and produces a saved-but-unpublished notice. Staff can explicitly publish again. Changing the destination and saving still edits the current panel in its original channel. **Publish / Move** creates the replacement, persists its IDs, then deletes the old panel. Repeating publication in the same channel edits the existing canonical message. If persistence fails, the bot rereads tracking to distinguish a lost response from a failed commit before removing the replacement. Cleanup failures include direct message links; if old-panel deletion fails, the bot also attempts to remove its obsolete button.

Publication/config mutations use database revisions and a configuration-level bot guard spanning Discord operations, consistent with the existing single-bot deployment. A process termination during an uncertain Discord send can require staff to inspect/reconcile a panel; an uncertain send is not blindly repeated.

## Opening and concurrency

1. Defer the user's response ephemerally and resolve their current guild member.
2. Request a backend reservation with a fresh operation UUID. PostgreSQL wins the race before Discord channel creation can begin.
3. If an active ticket exists, verify its channel. A valid channel is linked ephemerally. Creating/closing tickets receive an in-progress response. A confirmed missing channel is reconciled before retrying the reservation.
4. Validate category, configured roles, bot-log destination and required permissions.
5. Create an explicit private text channel, with a stable `console-ticket:<ticket UUID>` topic for recovery. Persist each resulting resource ID as it becomes available.
6. Create the bot-log root and its public transcript thread; write the opening lifecycle event.
7. Post the opening embed with creator content and the persistent Close Ticket button. Only the creator is eligible for a mention from that message.
8. Persist the opening-message ID and transition to open, then reply with the source channel.

The source name uses the current Discord **username**, followed by the ticket purpose. Names normalize accents, lowercase, replace invalid runs/spaces with hyphens, collapse separators and obey Discord's 100-character limit. Names are presentation only; IDs determine identity and uniqueness.

Explicit channel overwrites deny `@everyone` View Channel and grant the creator, bot, mapped moderator/administrator roles and additional configured roles the needed view/send/history/attachment/embed/reaction/application-command permissions. The bot also retains channel/overwrite management access. Discord Administrator naturally bypasses channel overwrites. Effective role IDs are snapshotted per instance so existing tickets retain their staff access if a type is later disabled or edited.

Creation failures delete incomplete source channels where possible and mark the reservation failed only after cleanup succeeds. Audit history is retained and failed root entries are updated where possible. Failed cleanup retains active uniqueness for recovery. A lost final open-commit response is verified against persistence before compensation, so it cannot destroy an already-open ticket.

Operation tokens fence checkpoints after recovery acquires ownership. Creating/closing leases last five minutes and are renewed at checkpoints. Maintenance runs every minute and skips work already executing in this bot process. This deployment assumes one active bot process for transcript/publication serialization; reservation uniqueness itself is enforced in PostgreSQL.

## Closure, manual deletion and restart recovery

Close Ticket first checks guild/channel identity and creator, ticket staff, current Moderator+ or Administrator authorization. It presents an ephemeral two-minute confirmation bound to the requesting user and ticket. Cancel keeps the channel. Confirm acquires persistent closing state exactly once and records the actor/time.

Closure queues a close-request event, freezes normal participant writes, catches up retained source messages, drains pending transcript content, writes the final lifecycle event, updates the root, and locks/archives the transcript. It then deletes the source channel and marks the instance closed. **Uniqueness is deliberately retained until source deletion succeeds**, preventing a leftover channel from coexisting with a replacement. This is a deliberate ordering refinement to the suggested lifecycle.

If deletion fails, the interaction reports incomplete closure; an audit failure entry is attempted and the ticket remains closing. Restore the missing permission and maintenance retries after the lease expires. Closing a type does not modify existing opening templates.

Channel-delete events trigger reconciliation. Missing source channels are also detected on the next create attempt and periodic recovery. Reconciliation records a stale/manual-deletion lifecycle event, updates/finalizes the audit where available, preserves the historical row and permits replacement. Missing Access/Permissions is never mistaken for Unknown Channel.

After restart the bot pages through backend active tickets, rebuilds source-channel routing, catches up retained message history and drains pending transcript events. Expired creation reservations recover channels by their exact ticket topic marker. Recovery can locate an uncheckpointed root by its stable ticket ID and bot authorship, and can recover a message-associated thread from the root ID. Expired closing operations are resumed with a new fenced operation token.

Disabling a configuration removes its canonical panel when possible and makes old Create Ticket buttons inactive. It never hard-deletes configuration, instances or transcript history. Existing tickets continue transcript routing and remain closable. Disabled types remain visible in staff lists/autocomplete for cleanup and auditability.

## Bot-log transcripts

The destination is the existing `/setchannels` **bot_log** configuration. Missing or unusable logging prevents normal ticket creation. Roots identify the ticket type/ID, creator/user ID, source channel, opened time and status. On close they also show closed time and closing actor. Root messages and threads are retained.

Each root has a Discord public thread named with a short ticket ID and the source name. It inherits visibility from the configured bot-log channel; configure that channel for the staff who should read private ticket transcripts.

Source messages, including staff/bot messages, record username, user ID, timestamp, message ID and content. Already-rendered embed text/fields and media URLs are included, preserving the opening questions. Attachments include filename, URL, byte size and available MIME type; files are not downloaded. All transcript sends disable mentions. Long entries split without truncation or broken surrogate pairs and repeat author/time context.

Edits append before/after entries. Deletes and bulk deletes append the known author/content; uncached deletes explicitly identify unavailable content instead of inventing it. Lifecycle entries cover opening, close request, closing/finalization, stale recovery and cleanup failure. No ticket message bodies are written to ordinary process logs.

Per-ticket queues serialize messages and finalization. PostgreSQL deduplicates event keys and stores per-chunk progress; deterministic Discord nonces reduce duplicate deliveries after uncertain sends. Failed backend enqueues remain in memory for retry before flushing/finalization; successfully enqueued content survives restarts. Source history catches up messages retained during downtime.

Discord cannot recover messages deleted, or earlier edit versions lost, while the gateway/bot was offline. A simultaneous process failure before a failed backend enqueue becomes durable can also lose that edit/delete event. Retained source messages can be recovered. A very late retry outside Discord's nonce-deduplication window may repeat a transcript chunk, favoring audit retention over content loss. Attachment links remain Discord URLs, not permanent file archives.

## Intents and deployment

Message Content intent was **already requested in the client**. It remains enabled in code; its comment now reflects guild-ticket use. `Partials.Message` was added for uncached message-delete events, alongside the existing GuildMessages intent. Production runtime verification asserts these options.

Before manual testing:

1. Ensure the Discord application's **Message Content Intent** is enabled in Developer Portal → Bot → Privileged Gateway Intents. No new intent bit or environment variable is introduced, but the external setting must permit actual guild message content. Existing Guild Members intent requirements remain unchanged.
2. Configure mapped moderator/administrator roles using `/setroles`, and a staff-readable `bot_log` text channel using `/setchannels`.
3. Give the bot View Channel, Send Messages, Embed Links and Read Message History in panel destinations. In bot logs it additionally needs Create Public Threads, Send Messages in Threads and Manage Threads. In ticket categories it needs View Channel, Manage Channels and Manage Roles for explicit overwrite management; it also needs the normal ticket communication permissions granted to it in new channels.
4. From the repository root, deploy fresh images with `docker compose up -d --build`. Backend startup applies forward-only migrations **077 and 078** (and earlier pending migrations, including saved-embed 075/076). For a local development database, run `npm run migrate` in `backend/`, then use the existing development Compose command.
5. Register the four new slash commands after building: `docker compose run --rm bot npm run register`. Local development uses `npm run register:dev` in `bot/` with the existing environment configuration.
6. Run `/createticket`, set the purpose/channel/category/optional roles, edit both previews, Save Ticket Type, then Publish / Move. Proceed with your manual Discord testing.

No manual Discord testing, live command registration, live migration or production deployment was performed during implementation.

## Files and automated verification

New full source files:

- `backend/src/db/migrations/077_tickets.sql`, `078_ticket_transcript_outbox.sql`
- `backend/src/lib/tickets/contract.ts`
- `backend/src/lib/services/ticket-service.ts`, `ticket.integration.test.ts`
- `backend/src/routes/admin/tickets.ts`
- `backend/src/scripts/check-ticket-runtime.ts`
- `bot/src/commands/configs/tickets.ts`
- `bot/src/lib/tickets/api.ts`, `builder.ts`, `contract.ts`, `discord.ts`, `lifecycle.ts`, `publication.ts`, `transcript.ts`, `tickets.test.ts`
- `bot/src/lib/embeds/editing.ts`
- `docs/tickets.md`

Updated full source files:

- `backend/src/server.ts`: registers ticket routes.
- `bot/src/commands/index.ts`: registers the four commands.
- `bot/src/index.ts`: component/event routing and message partials.
- `bot/src/lib/utilities/safe-handle-interaction.ts`: supports role-select interactions.
- `bot/src/lib/embeds/builder.ts`, `session.ts`, `ui.ts`: shared mutations, editor namespace and actor typing; existing saved-embed behavior retained.
- `bot/src/scripts/check-production-runtime.ts`: asserts ticket intents/partials.
- `bot/scripts/check-esm-imports.mjs`: optional service-root argument, used to check backend imports too.

Pre-existing saved-embed and unrelated working-tree changes were preserved.

The ticket tests exercise the real bot builder/publication/lifecycle/transcript orchestration with mocks at Discord and backend-client boundaries, plus real PostgreSQL/Fastify integration for reservations, transitions, guild security and the outbox. The compiled backend runtime check also exercises actual authenticated routes against isolated PostgreSQL without service mocks.

Verified September 7–8, 2026:

| Automated check | Result |
| --- | --- |
| Targeted bot ticket tests | **53 passed**, zero failures/skips. |
| Backend ticket PostgreSQL/HTTP integration | **27 passed**, zero failures/skips. |
| Full bot suite | **315 passed**, zero failures/skips. |
| Full backend suite | **320 passed** across 24 files, zero failures/skips. |
| Strict TypeScript builds | Both services passed locally and in production Docker builds. |
| Clean-database migrations | All **78** migrations applied to a newly created isolated PostgreSQL database. |
| ESM imports and exact filename casing | **932 bot / 271 backend** relative specifiers passed. |
| Production bot graph | Compiled bot and registration graphs loaded in the production image; GuildMessages/MessageContent/Message partial assertions passed. |
| Production backend graph | Compiled server loaded and started inside an isolated container without a host port. |
| Production ticket API runtime | Authenticated compiled configuration, reservation, duplicate prevention, outbox and closure passed against isolated PostgreSQL. |
| Compiled migration entrypoint | Successfully recognized all applied migrations in the production image. |
| Whitespace | `git diff --check` passed. |

Reproduce bot tests from `bot/` with Node 22 (the existing tests use experimental module mocking):

```powershell
npm run build
$tests = @(rg --files src -g '*.test.ts')
node --experimental-test-module-mocks --import tsx --test @tests
npm run check:esm-imports
node scripts/check-esm-imports.mjs ../backend
npm run check:production-runtime
```

Run backend tests from `backend/` with `TEST_DATABASE_URL` and `DATABASE_URL` pointing to an **isolated test database**, never production:

```powershell
npm run migrate:test
npm test
npm run build
```

`node dist/scripts/check-ticket-runtime.js` additionally requires a database named `console_ticket_verify_*` and refuses other database names. Normal production remains on the existing Node 20 Docker images; no runtime dependency was added.
