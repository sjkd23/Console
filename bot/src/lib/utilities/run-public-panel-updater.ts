import { Client, ChannelType, EmbedBuilder, type MessageEditOptions } from 'discord.js';
import { getRunDetails } from './http.js';
import { dungeonByCode } from '../../constants/dungeons/dungeon-helpers.js';
import { createLogger } from '../logging/logger.js';
import { buildRunButtons } from './run-panel-builder.js';
import {
    buildRunLifecycleMessageContent,
    buildRunMessageContentEdit,
    isO3RealmClosedStage,
} from './run-message-helpers.js';
import { resolveDungeonRolePingIds } from './dungeon-role-pings.js';
import { syncActiveRunsMirror } from './active-runs-mirror.js';

const logger = createLogger('RunPublicPanelUpdater');

export function shouldRefreshRunPublicMessage(status: 'open' | 'live' | 'ended'): boolean {
    return status !== 'ended';
}

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
        const run = await getRunDetails(runId, guildId);

        // Only update if the run is still active
        if (!shouldRefreshRunPublicMessage(run.status)) {
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
        const dungeons = run.selectedDungeons.map(selection => dungeonByCode[selection.dungeonKey]);
        if (dungeons.some(dungeon => dungeon === undefined)) {
            logger.warn('Unknown selected dungeon for public panel update', { guildId, runId, selectedDungeons: run.selectedDungeons });
            return;
        }

        // Rebuild the button components with the updated join button state
        const components = buildRunButtons({
            runId: runId,
            dungeonData: dungeons,
            runKind: run.runKind,
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
        const run = await getRunDetails(runId, guildId);
        await syncActiveRunsMirror(client, guildId, runId);

        if (run.status === 'ended') {
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

        const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
        const additionalPings = guild
            ? await resolveDungeonRolePingIds(guild, run.selectedDungeons.map(dungeon => dungeon.dungeonKey))
            : [];
        if (guild && run.roleId && (guild.roles.cache.has(run.roleId) || await guild.roles.fetch(run.roleId).catch(() => null))) {
            additionalPings.push(run.roleId);
        }
        const content = buildRunLifecycleMessageContent(run, {
            additionalPingRoleIds: additionalPings,
        });

        const dungeons = run.selectedDungeons.map(selection => dungeonByCode[selection.dungeonKey]);
        if (dungeons.some(dungeon => dungeon === undefined)) {
            logger.warn('Unknown selected dungeon for public panel content update', {
                guildId,
                runId,
                selectedDungeons: run.selectedDungeons
            });
            return;
        }

        const components = buildRunButtons({
            runId,
            dungeonData: dungeons,
            runKind: run.runKind,
            joinLocked: run.joinLocked,
            o3Stage: run.o3Stage
        });
        const editOptions: MessageEditOptions = {
            ...buildRunMessageContentEdit(content),
            components,
        };
        const realmIsClosed = run.runKind === 'oryx_3' && isO3RealmClosedStage(run.o3Stage);

        if (realmIsClosed && message.embeds[0]) {
            const originalEmbed = message.embeds[0];
            const updatedEmbed = EmbedBuilder.from(originalEmbed)
                .setTitle(`🔴 Closed: ${run.selectedDungeons.map(dungeon => dungeon.dungeonLabel).join(' | ')}`);
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
