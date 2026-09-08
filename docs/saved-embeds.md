# Saved embeds and canonical publication

## Why the old behavior occurred

Migration 075 created reusable templates containing structured configuration, name, guild, creator, timestamps and revision. It had no Discord channel or message ID columns. The original Save handler only called the backend update, Publish always called `channel.send()`, and confirmed Delete only deleted the database row. Those behaviors followed the original template-only model; there was no recorded message for Save or Delete to target.

## Final lifecycle and controls

All commands remain guild-only Moderator+ tools using the existing role mappings and Administrator override. No slash-command names/options changed in this revision.

1. `/createembed` opens an ephemeral builder. Edit properties and use Save to give the reusable configuration a guild-unique name.
2. Select a text channel and Publish. An unsaved draft must be saved first, and pending edits must be saved before publishing or moving. Publication sends exactly the saved preview and records the new channel/message IDs.
3. `/editembed` restores the configuration, preview, publication IDs and published channel selection.
4. Save Changes wins the database revision check and persists configuration before editing the exact tracked Discord message. It never sends a replacement automatically. Save remains available on published templates so a failed Discord update can be retried even when configuration is already saved.
5. Repeated Publish on a valid tracked post sends no duplicate and directs staff to Save Changes. If the tracked post disappeared, Publish reconciles the stale reference and can publish a new canonical post.
6. `/deleteembed` previews the template and asks for confirmation that both the saved embed and its tracked message will be deleted. It validates the current saved revision, removes the tracked Discord message, then deletes the backend record. All in-memory builders for that saved embed are discarded after success.

The normal builder content shows selected Channel, published-message link, save status and operation feedback. These remain outside the actual embed. `/listembeds` and saved-name autocomplete remain guild-scoped and ephemeral.

## Description editor

Description now uses exactly **one optional paragraph text input with maxLength 4000**. There is no continuation input. Empty input clears the description when another meaningful embed property remains. The submit handler independently enforces the 4000-character editing limit.

The reusable validation contract still accepts existing valid descriptions up to Discord's 4096-character limit, so migration and template reads do not truncate saved data. If a legacy description is longer than 4000, the builder warns that editing it replaces it with at most 4000 characters; opening or saving unrelated properties preserves the original. Title, color, fields, footer/icon, image, thumbnail, author/icon/URL, title URL and timestamp controls remain supported. Timestamp remains fixed to the time it was enabled so publication matches the preview.

## Missing messages and Discord failures

Unknown Channel/Unknown Message responses and an absent channel reconcile stale state. Missing Access, Missing Permissions and other Discord failures are not treated as deletion. The bot resolves tracked channels through the current guild and verifies that the tracked message is in that guild/channel and authored by this bot before editing or deleting it.

If Save encounters a deleted post/channel, it keeps the newly saved configuration, clears both publication IDs and reports that staff can publish again. If the message disappears between fetch and edit, the same reconciliation applies. Confirmed deletion continues when the old post/channel is already gone.

If configuration saves but Discord editing fails, the UI explicitly says the configuration was saved and the post update failed; no new message is sent. Staff can retry Save Changes after restoring access. Structured logs include guild, template ID/name, channel ID, message ID and failure code/type without logging embed bodies.

## Explicit channel moves and compensation

Choosing another Channel does not move a post. Save Changes still updates the existing canonical message in its original channel. The action button becomes **Move Published Embed**; pressing it explicitly requests relocation.

The workflow creates the replacement first, records its successfully created IDs with a revision-guarded write, and only then deletes the old message. Recording before deletion preserves the old post if persistence fails. If the old post is already gone, deletion is reconciled. If old-post deletion fails, the bot attempts to restore the old canonical pointer and remove the replacement. It reports any incomplete rollback/cleanup and links the messages needing attention.

When publication persistence fails, the bot rereads authoritative tracking before cleanup: a lost HTTP response may have followed a successful database commit. A newly sent message that was not recorded is deleted where possible. If neither persistence nor its verification can be confirmed, the bot preserves the new and old messages and reports the uncertainty with the new message link; it does not delete a potentially canonical post blindly. Cleanup failures are explicit and logged.

Database and Discord changes cannot be one atomic transaction. A process termination between sending and recording, or during a move, can still require manual reconciliation. No automatic duplicate-producing retry or fallback send is performed.

## Persistence, isolation and concurrency

**Migration 076: `backend/src/db/migrations/076_saved_embed_publication.sql`** adds nullable BIGINT `published_channel_id` and `published_message_id`. A check constraint requires both IDs to be present or both null. A partial unique index prevents the same guild/channel/message tuple from being assigned to multiple templates. There is one canonical pair per saved embed.

Every saved-template and publication write is guild-scoped and revision-guarded in SQL. Publication request bodies also carry a validated guild ID which must match the route guild. The trusted bot supplies IDs obtained from current-guild Discord operations, not arbitrary component/modal message IDs. Existing shared-secret and Moderator authorization guard all endpoints.

The new `/:id/claim` and `/:id/publication` authenticated POST endpoints extend the existing `/v1/guilds/:guild_id/saved-embeds` API. Claim advances the expected revision before Publish/Move/Delete side effects. Publication sets or clears the pair only at the expected revision. Save already advances the revision before editing Discord. Rejected stale saves never touch Discord.

Within the existing single-bot deployment, a per-guild/template guard spans the entire database-plus-Discord workflow across all open builders, so a later save cannot overtake an earlier Discord edit. This builds on the existing per-session owner/message/revision checks. It is not a distributed multi-bot lock.

## Reusable APIs and future tickets

`getSavedEmbed(guildId, id)` in the backend returns structured configuration and metadata without publication side effects. Bot API reads likewise do not create/edit/delete Discord messages. `renderEmbed(config)` remains a pure validated renderer. `sendEmbedCopy(...)` explicitly sends an independent copy without reading or updating canonical tracking. The existing `publishEmbed(...)` wrapper retains copy-only compatibility.

Canonical management is isolated in `bot/src/lib/embeds/publication.ts`: `saveManagedEmbed`, `publishManagedEmbed`, and `deleteManagedEmbed`. Future ticket copies must use the reusable configuration/renderer or copy helper, not these management functions. No tickets were implemented.

## Files changed by this follow-up

- `backend/src/db/migrations/076_saved_embed_publication.sql` (new; migration 075 unchanged).
- `backend/src/lib/embeds/contract.ts` and matching `bot/src/lib/embeds/contract.ts`.
- `backend/src/lib/services/saved-embed-service.ts` and `backend/src/routes/admin/saved-embeds.ts`.
- `backend/src/lib/services/saved-embed.integration.test.ts`.
- `bot/src/lib/embeds/publication.ts` (new).
- `bot/src/lib/embeds/api.ts`, `builder.ts`, `session.ts`, and `ui.ts`.
- `bot/src/lib/embeds/builder.test.ts` and `contract.test.ts`.
- `docs/saved-embeds.md`.

Other working-tree changes from the original implementation and unrelated work were preserved.

## Tests and verification

The bot regression coverage exercises one-input Description editing/clearing and limits; initial tracking; reopen; save-in-place; no duplicate Publish; missing message/channel reconciliation; permission errors; stale Save/Delete; serialized cross-builder operations; explicit moves and rollback; newly created message cleanup; lost persistence/reconciliation/rollback responses; deletion; ownership/guild validation; and copy-only reuse. PostgreSQL/API tests verify migration constraints, paired references, persistence through config updates, stale claims/publication writes, cross-guild rejection and unique canonical ownership, in addition to the existing template tests.

Verified September 7, 2026:

- Targeted bot saved-embed tests: **67 passed**, zero failures/skips.
- Backend saved-embed PostgreSQL/API tests: **12 passed**.
- Full bot suite: **262 passed**, zero failures/skips.
- Full backend suite: **293 passed** across 23 files, zero failures/skips.
- Strict TypeScript builds passed for both services.
- ESM imports and exact filename casing passed for both services (876 bot / 252 backend specifiers).
- Production Docker builds passed for both services. The bot image loaded the compiled bot and registration module graphs; the backend image exercised authenticated create, claim, publication tracking, config update preserving tracking, and deletion against isolated PostgreSQL.
- All **76 migrations** applied to a fresh isolated PostgreSQL database. The compiled production migration entrypoint also ran successfully on the migrated database.
- `git diff --check` passed.

Tests used isolated PostgreSQL and mocked Discord interactions. No manual Discord testing or live deployment was performed.

## Before manual testing

Apply migration **076**, then rebuild/restart both backend and bot. If deploying the original feature for the first time, migrations 075 and 076 are both needed. Production Compose runs migrations at backend startup; development can run `npm run migrate` from `backend/`. Existing commands do not require re-registration for this follow-up; first-time installation of the four embed commands still does.

**Previously sent messages cannot be linked retroactively:** the old implementation never recorded their IDs. Existing templates start with null publication references. Remove obsolete legacy copies manually before publishing a newly tracked canonical post if you want only one visible copy. The bot does not guess ownership by scanning channel history.

No new environment variables or external services are required. The bot needs channel visibility and the ability to send/embed in destinations and fetch its tracked messages (including Read Message History). Staff still need the established Moderator+ authorization; copy/publication destinations also enforce View Channel, Send Messages and Embed Links for the invoking member.
