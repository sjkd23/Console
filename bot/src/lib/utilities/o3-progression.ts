import { Client, Guild } from 'discord.js';
import { getRunDisplayLabel } from './http.js';
import { updateO3StatusMessage } from './o3-status-message.js';

/**
 * Shared interface for O3 progression ping messages.
 * Follows DRY principles by extracting common logic.
 */
interface O3ProgressionOptions {
    /** The main message text (e.g., "Realm Closed", "Mini: Dammah") */
    messageText: string;
    /** The run ID */
    runId: number;
    /** The guild where the run is happening */
    guild: Guild;
    /** The Discord client */
    client: Client;
    /** Optional: Include party/location info in message */
    includePartyLocation?: boolean;
}

/**
 * Updates the tracked O3 status message without another role ping.
 * This is the shared implementation for Realm Closed, Miniboss, and Third Room pings.
 * 
 * @returns The tracked status message ID, or null if failed
 */
export async function sendO3ProgressionPing(options: O3ProgressionOptions): Promise<string | null> {
    const { messageText, runId, guild, client, includePartyLocation = true } = options;

    return updateO3StatusMessage(client, guild, runId, run => {
        // Build the ping message
        let content = `**${messageText}**`;

        // Add role mention if available
        if (run.roleId) {
            content += ` <@&${run.roleId}>`;
        }

        content += `\n\n**${getRunDisplayLabel(run)}**`;

        // Add party/location info if requested and available
        if (includePartyLocation) {
            const info: string[] = [];
            if (run.party) info.push(`Party: **${run.party}**`);
            if (run.location) info.push(`Location: **${run.location}**`);
            if (info.length > 0) {
                content += ` • ${info.join(' • ')}`;
            }
        }

        // Add link to the raid panel
        const raidPanelUrl = `https://discord.com/channels/${guild.id}/${run.channelId}/${run.postMessageId}`;
        content += `\n[Jump to Raid Panel](${raidPanelUrl})`;

        return {
            content,
            reply: {
                messageReference: run.postMessageId!,
                failIfNotExists: true
            }
        };
    });
}
