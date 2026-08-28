import { Client, ChannelType, EmbedBuilder, type MessageEditOptions } from 'discord.js';
import { z } from 'zod';
import { getJSON } from './http.js';
import { dungeonByCode } from '../../constants/dungeons/dungeon-helpers.js';
import { createLogger } from '../logging/logger.js';
import { buildRunButtons } from './run-panel-builder.js';
import { buildRunMessageContent, isO3RealmClosedStage } from './run-message-helpers.js';

const logger = createLogger('RunPublicPanelUpdater');

const runPublicPanelContentStateSchema = z.object({
    status: z.string(),
    dungeonKey: z.string(),
    dungeonLabel: z.string(),
    joinLocked: z.boolean(),
    party: z.string().nullable(),
    location: z.string().nullable(),
    o3Stage: z.enum(['closed', 'miniboss', 'third_room']).nullable(),
    channelId: z.string().nullable(),
    postMessageId: z.string().nullable()
});

/**
 * Updates the public run panel buttons to reflect the current join_locked state.
 * This is called when the organizer toggles the lock join button.
 */
export async function updateRunPublicPanel(
    client: Client,
    guildId: string,
    channelId: string,
    messageId: string,
    runId: number
): Promise<void> {
    try {
        // Fetch the latest run state
        const run = await getJSON<{
            status: string;
            dungeonKey: string;
            joinLocked: boolean;
            o3Stage: 'closed' | 'miniboss' | 'third_room' | null;
        }>(`/runs/${runId}`, { guildId });

        // Only update if the run is still active
        if (run.status === 'ended' || run.status === 'cancelled') {
            return;
        }

        // Fetch the channel and message
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel || channel.type !== ChannelType.GuildText) {
            logger.warn('Could not fetch channel for public panel update', { guildId, channelId, runId });
            return;
        }

        const message = await channel.messages.fetch(messageId).catch(() => null);
        if (!message) {
            logger.warn('Could not fetch message for public panel update', { guildId, channelId, messageId, runId });
            return;
        }

        // Get dungeon info for key buttons
        const dungeon = dungeonByCode[run.dungeonKey];
        if (!dungeon) {
            logger.warn('Unknown dungeon key for public panel update', { guildId, runId, dungeonKey: run.dungeonKey });
            return;
        }

        // Rebuild the button components with the updated join button state
        const components = buildRunButtons({
            runId: runId,
            dungeonData: dungeon,
            joinLocked: run.joinLocked,
            o3Stage: run.o3Stage
        });

        // Update the message with new components
        await message.edit({
            components: components
        });

        logger.debug('Public panel updated successfully', {
            guildId,
            runId,
            joinLocked: run.joinLocked
        });
    } catch (error) {
        logger.error('Failed to update public panel', {
            guildId,
            runId,
            channelId,
            messageId,
            error: error instanceof Error ? error.message : String(error)
        });
        // Don't throw - this is a non-critical update
    }
}

/**
 * Refreshes the persistent public run message content from the latest backend state.
 */
export async function updateRunPublicPanelContent(
    client: Client,
    guildId: string,
    runId: string | number
): Promise<void> {
    try {
        const response = await getJSON<unknown>(`/runs/${runId}`, { guildId });
        const run = runPublicPanelContentStateSchema.parse(response);

        if (run.status !== 'live') {
            return;
        }

        if (!run.channelId || !run.postMessageId) {
            logger.warn('Run is missing public message identifiers for content update', {
                guildId,
                runId,
                channelId: run.channelId,
                messageId: run.postMessageId
            });
            return;
        }

        const channel = await client.channels.fetch(run.channelId).catch(() => null);
        if (!channel || channel.type !== ChannelType.GuildText) {
            logger.warn('Could not fetch channel for public panel content update', {
                guildId,
                channelId: run.channelId,
                runId
            });
            return;
        }

        const message = await channel.messages.fetch(run.postMessageId).catch(() => null);
        if (!message) {
            logger.warn('Could not fetch message for public panel content update', {
                guildId,
                channelId: run.channelId,
                messageId: run.postMessageId,
                runId
            });
            return;
        }

        const additionalPings = Array.from(
            message.content.matchAll(/<@&(\d+)>/g),
            match => match[1]
        );
        const content = buildRunMessageContent(
            run.party,
            run.location,
            additionalPings,
            run.o3Stage
        );

        const dungeon = dungeonByCode[run.dungeonKey];
        if (!dungeon) {
            logger.warn('Unknown dungeon key for public panel content update', {
                guildId,
                runId,
                dungeonKey: run.dungeonKey
            });
            return;
        }

        const components = buildRunButtons({
            runId,
            dungeonData: dungeon,
            joinLocked: run.joinLocked,
            o3Stage: run.o3Stage
        });
        const editOptions: MessageEditOptions = { content, components };
        const realmIsClosed = run.dungeonKey === 'ORYX_3' && isO3RealmClosedStage(run.o3Stage);

        if (realmIsClosed && message.embeds[0]) {
            const originalEmbed = message.embeds[0];
            const updatedEmbed = EmbedBuilder.from(originalEmbed)
                .setTitle(`🔴 Closed: ${run.dungeonLabel}`);
            const realmScoreText = '**Realm Score:** 100%';
            const originalDescription = originalEmbed.description ?? '';
            const description = originalDescription.includes('**Realm Score:**')
                ? originalDescription.replace(/\*\*Realm Score:\*\*\s*\d+%/, realmScoreText)
                : `${originalDescription}${originalDescription ? '\n\n' : ''}${realmScoreText}`;

            updatedEmbed.setDescription(description);
            editOptions.embeds = [updatedEmbed, ...message.embeds.slice(1)];
        }

        await message.edit(editOptions);

        logger.debug('Public panel content updated successfully', {
            guildId,
            runId,
            o3Stage: run.o3Stage
        });
    } catch (error) {
        logger.error('Failed to update public panel content', {
            guildId,
            runId,
            error: error instanceof Error ? error.message : String(error)
        });
        // Don't throw - this is a non-critical update after the backend state change.
    }
}
