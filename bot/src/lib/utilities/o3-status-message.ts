import type { Client, Guild, MessageCreateOptions } from 'discord.js';
import { getRunDetails, postJSON, type RunDetails } from './http.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('O3StatusMessage');
const pending = new Map<number, Promise<string | null>>();

/** Serialize status publications so simultaneous updates cannot create two originals. */
export async function updateO3StatusMessage(
    client: Client,
    guild: Guild,
    runId: number,
    buildMessage: (run: RunDetails) => MessageCreateOptions,
): Promise<string | null> {
    const previous = pending.get(runId) ?? Promise.resolve(null);
    const operation = previous.then(async () => {
        try {
            // Read after the preceding publication has persisted its message ID.
            const run = await getRunDetails(runId, guild.id);
            if (run.runKind !== 'oryx_3' || !run.channelId || !run.postMessageId) return null;
            const channel = await client.channels.fetch(run.channelId);
            if (!channel || !channel.isTextBased() || channel.isDMBased()) return null;

            const payload = buildMessage(run);
            if (run.o3StatusMessageId) {
                // Missing messages and edit failures leave tracking intact and never re-ping.
                const message = await channel.messages.fetch(run.o3StatusMessageId);
                await message.edit({ content: payload.content, allowedMentions: { parse: [] } });
                return message.id;
            }

            const message = await channel.send(payload);
            await postJSON(`/runs/${runId}/o3-status-message`, {
                o3StatusMessageId: message.id,
            }, { guildId: guild.id });
            return message.id;
        } catch (error) {
            logger.error('Failed to publish O3 status message', { runId, error });
            return null;
        }
    });
    pending.set(runId, operation);
    try {
        return await operation;
    } finally {
        if (pending.get(runId) === operation) pending.delete(runId);
    }
}
