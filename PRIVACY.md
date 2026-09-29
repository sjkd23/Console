# Console Privacy Policy

Last updated: September 28, 2026

## Overview

Console is a Discord bot used by Realm of the Mad God communities for raid organization, player verification, participation statistics, staff quotas, moderation, modmail, and private tickets.

## Information Console Processes

Depending on the features you use, Console may process or store:

- Discord user and server IDs; channel and role IDs; usernames and server nicknames.
- Verified in-game names, RealmEye profile information used for verification, screenshots, verification status, and staff review details.
- Raid participation, organizer statistics, key contributions, quota points, periods, and results.
- Moderation actions, reasons, staff notes, modmail messages and attachment URLs, and command or audit records.
- Ticket requests, form answers, processing and delivery records, messages in Console-managed ticket channels, and attachment names, sizes, types, and URLs.

Console does not collect every category from every user. Console does not collect Discord Presence information.

## How Information Is Used

Console uses this information to run raids, verify players, track participation and quotas, support moderation and modmail, deliver ticket transcripts, manage server settings, and maintain reliable operation, audit records, and troubleshooting.

## Ticket Transcripts

Ticket conversations in Console-managed ticket channels are transcribed to the server's configured Discord transcript location for authorized staff. Ticket messages visibly state: “Ticket conversations are logged for transcript purposes.” Transcripts can include message text, edits or deletions known to Console, and attachment details and URLs.

To deliver transcripts reliably, Console may temporarily keep pending or partly delivered transcript events in its database. Their readable content remains there while delivery or recovery is needed. Once a complete event is delivered and acknowledged, Console clears that content from the current database row; identifying and delivery details may remain. The rendered transcript remains in Discord. Clearing the database row does not immediately remove copies in backups or older database storage.

## Modmail

Modmail is separate from ticket transcript delivery. Console stores submitted modmail messages and attachment URLs in its database as support history. Closing modmail does not automatically delete that history.

## Data Retention

Retention varies by record. Pending or partly delivered ticket transcript content remains until delivery succeeds or the operator acts; acknowledged content is cleared as described above. Modmail history can remain after closure. Historical raid, statistics, and quota records generally persist, and moderation and audit records may remain for administration and accountability. Some information can be updated or deleted through specific workflows, but there is no automatic expiry for all stored data.

## Data Sharing

Appropriate staff of a Discord server may see information through Console's configured outputs, including moderation records and ticket transcript channels. Console's operating infrastructure, including its database and hosting environment, also processes or stores data. Console does not sell user data.

## AI and Machine Learning

Discord message content collected by Console is not used to train machine-learning or AI models.

## Data Access, Correction, and Deletion

You can request access to, correction of, or deletion of information associated with you. Contact `@sjkd` on Discord or the repository owner and maintainer `sjkd23` through GitHub. If needed to find the right records, provide your Discord user ID privately; do not post personal information in a public GitHub issue.

Requests are handled manually. Information may need to be retained where required by applicable law. Deleted information can temporarily persist in backups or infrastructure copies until those copies expire or are overwritten. Deleting information from Console's database does not automatically delete messages or transcripts already stored inside Discord. For copies held in a server, you may also need to contact that server's administrators.

## Security

Reasonable measures are used to restrict access to and protect stored data.

## Changes to This Policy

This policy may be updated as Console's features or data practices change. The current version will remain available in this repository.
