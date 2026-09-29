import type { Client, Guild, MessageCreateOptions } from 'discord.js';
import { getRunDetails, type RunDetails } from './http.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('O3StatusMessage');
const pending = new Map<number, Promise<string | null>>();

/** Serialize edits to the O3 start announcement. */
export async function updateO3StatusMessage(
    client: Client,
    guild: Guild,
    runId: number,
    buildMessage: (run: RunDetails) => MessageCreateOptions,
): Promise<string | null> {
    const previous = pending.get(runId) ?? Promise.resolve(null);
    const operation = previous.then(async () => {
        try {
            // Resolve the start announcement from persisted per-run tracking.
            const run = await getRunDetails(runId, guild.id);
            if (run.runKind !== 'oryx_3' || !run.channelId || !run.postMessageId) return null;
            const channel = await client.channels.fetch(run.channelId);
            if (!channel || !channel.isTextBased() || channel.isDMBased()) return null;

            if (!run.o3StatusMessageId) return null;
            // Missing messages and edit failures leave tracking intact; never send a replacement.
            const message = await channel.messages.fetch(run.o3StatusMessageId);
            const payload = buildMessage(run);
            let content = payload.content ?? '';
            // Keep the original @here and configured role mentions visible on every update.
            const originalMentions = [...new Set(message.content.match(/@here|@everyone|<@&\d+>/g) ?? [])];
            const missingMentions = originalMentions.filter(mention => !content.includes(mention));
            if (missingMentions.length > 0) content = `${missingMentions.join(' ')} ${content}`;
            await message.edit({ content, allowedMentions: { parse: [] } });
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
