# Console Privacy Policy

Last updated: October 2, 2026

## Overview

Console is a Discord bot used by Realm of the Mad God communities for raid organization, player verification, participation statistics, staff quotas, moderation, modmail, and private tickets.

## Information Console Processes

Depending on the features you use, Console may process or store:

- Discord/API identifiers and metadata: user, server, channel, role, and message IDs; usernames and server nicknames; raid participation, organizer statistics, key contributions, quota points, periods, and results.
- Ordinary guild messages in Console-managed ticket channels: conversation text, known edits/deletions, embed text/media references, and attachment names, sizes, types, and URLs. This transcription uses the privileged guild Message Content intent.
- Direct messages: submitted modmail support messages and attachment URLs, and verification submissions sent to the bot. DMs are separate from privileged guild Message Content.
- Structured interaction, modal, and slash-command input: ticket requests and form answers, in-game names, verification screenshots/review details, moderation reasons and staff notes, support replies, and command/audit records. This input does not require privileged guild Message Content.
- Administrator-authored configuration/content: server settings, verification instructions, ticket templates, saved embed text and media references, and dungeon raid images, including uploaded image file bytes stored in the database.
- RealmEye profile information used for verification, and limited operational diagnostic metadata such as operation names, IDs, SQL/error codes, and timings. Sensitive database writes redact parameters and repeated error details in diagnostic logs.

Console does not collect every category from every user. Console does not collect Discord Presence information.

Discord.js transiently receives and caches gateway messages Discord delivers to the bot, including messages outside managed tickets. Console does not generally archive arbitrary guild conversation in PostgreSQL.

## How Information Is Used

Console uses this information to run raids, verify players, track participation and quotas, support moderation and modmail, deliver ticket transcripts, manage server settings, and maintain reliable operation, audit records, and troubleshooting.

## Ticket Transcripts

Ticket conversations in Console-managed ticket channels are transcribed to the server-configured Discord logging/transcript destination. Access is governed by that server's Discord permissions, which administrators control. Ticket messages visibly state: “Ticket conversations are logged for transcript purposes.” Transcripts can include message text, edits or deletions known to Console, and embed and attachment details and URLs.

To deliver transcripts reliably, Console may temporarily keep pending or partly delivered transcript events in its database. Their readable chunks remain there while delivery or recovery is needed. After the final sequential acknowledgement for an event, Console clears its readable chunks from the completed outbox row; identifying and delivery details may remain. The rendered transcript remains in Discord. Clearing the database row does not immediately remove copies in backups or older database storage.

## Modmail

Modmail is separate from ticket transcript delivery. Console stores DM-based support submissions, attachment URLs, and staff replies submitted through commands as support history in its database. Closing modmail does not automatically delete that history. This history is not the justification for privileged guild Message Content.

## Data Retention

Retention varies by record. Pending or partly delivered ticket transcript content remains until delivery succeeds or the operator acts; acknowledged content is cleared as described above. Modmail history can remain after closure. Historical raid, statistics, and quota records generally persist, and moderation and audit records may remain for administration and accountability. Some information can be updated or deleted through specific workflows, but there is no automatic expiry for all stored data.

## Data Sharing

Information is delivered through the server's configured outputs, including moderation records and ticket transcripts; visibility depends on that server's Discord permissions. Console's operating infrastructure, including its database and hosting environment, also processes or stores data. Console does not sell user data.

## AI and Machine Learning

Discord message content collected by Console is not used to train machine-learning or AI models.

## Data Access, Correction, and Deletion

You can request access to, correction of, or deletion of information associated with you. Contact `@sjkd` on Discord or the repository owner and maintainer `sjkd23` through GitHub. If needed to find the right records, provide your Discord user ID privately; do not post personal information in a public GitHub issue.

Requests are handled manually. Information may need to be retained where required by applicable law. Deleted information can temporarily persist in backups or infrastructure copies until those copies expire or are overwritten. Deleting information from Console's database does not automatically delete messages or transcripts already stored inside Discord. For copies held in a server, you may also need to contact that server's administrators.

## Security

Reasonable measures are used to restrict access to and protect stored data.

## Changes to This Policy

This policy may be updated as Console's features or data practices change. The current version will remain available in this repository.
