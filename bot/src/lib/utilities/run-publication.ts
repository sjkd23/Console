import type { Client, Guild, GuildTextBasedChannel, Message } from 'discord.js';
import { dungeonByCode } from '../../constants/dungeons/dungeon-helpers.js';
import type { DungeonInfo } from '../../constants/dungeons/dungeon-types.js';
import type { CreateRunResponse } from './http.js';
import { postJSON } from './http.js';
import { buildRunButtons, buildRunEmbed } from './run-panel-builder.js';
import { resolveDungeonRolePingIds } from './dungeon-role-pings.js';
import { buildRunLifecycleMessageContent } from './run-message-helpers.js';
import { autoJoinOrganizerToRun } from './auto-join-helpers.js';
import { addRunReactions } from './run-reactions.js';
import { sendEarlyLocNotification } from './early-loc-notifier.js';
import { logRaidCreation } from '../logging/raid-logger.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('RunPublication');

export function resolveCreatedRunDungeons(created: CreateRunResponse): DungeonInfo[] {
    return created.selectedDungeons.map(selection => {
        const dungeon = dungeonByCode[selection.dungeonKey];
        if (!dungeon) throw new Error(`Missing bot metadata for dungeon ${selection.dungeonKey}.`);
        return { ...dungeon, dungeonName: selection.dungeonLabel };
    });
}

export async function publishCreatedRun(options: {
    guild: Guild;
    raidChannel: GuildTextBasedChannel;
    organizerId: string;
    created: CreateRunResponse;
    description?: string;
    party?: string;
    location?: string;
}): Promise<Message<true>> {
    const dungeons = resolveCreatedRunDungeons(options.created);
    const rolePingIds = await resolveDungeonRolePingIds(
        options.guild,
        options.created.selectedDungeons.map(dungeon => dungeon.dungeonKey)
    );
    const sent = await options.raidChannel.send({
        content: buildRunLifecycleMessageContent({
            selectedDungeons: options.created.selectedDungeons,
            party: options.party,
            location: options.location,
        }, { additionalPingRoleIds: rolePingIds }),
        embeds: [buildRunEmbed({
            dungeonData: dungeons,
            runKind: options.created.runKind,
            organizerId: options.organizerId,
            status: 'starting',
            description: options.description,
        })],
        components: buildRunButtons({
            runId: options.created.runId,
            dungeonData: dungeons,
            runKind: options.created.runKind,
            joinLocked: false,
        }),
    });
    try {
        await postJSON(`/runs/${options.created.runId}/message`, { postMessageId: sent.id }, {
            guildId: options.guild.id,
        });
    } catch (error) {
        await sent.delete().catch(() => undefined);
        throw error;
    }
    return sent;
}

export function initializePublishedRun(options: {
    client: Client;
    guild: Guild;
    message: Message<true>;
    created: CreateRunResponse;
    organizerId: string;
    organizerUsername: string;
    roleId?: string;
    party?: string;
    location?: string;
    description?: string;
}): void {
    const displayLabel = options.created.selectedDungeons.map(dungeon => dungeon.dungeonLabel).join(' | ');
    Promise.all([
        autoJoinOrganizerToRun(
            options.client,
            options.guild,
            options.message,
            options.created.runId,
            options.organizerId,
            options.organizerUsername,
            options.created.dungeonKey,
            displayLabel,
            options.roleId ?? null
        ),
        addRunReactions(options.message, options.created.dungeonKey),
        options.created.earlyLocNotification
            ? sendEarlyLocNotification(
                options.client,
                options.guild.id,
                options.organizerId,
                options.created.dungeonKey,
                displayLabel,
                options.message.channelId,
                options.message.id,
                options.created.earlyLocNotification,
                options.created.selectedDungeons
            )
            : Promise.resolve(),
    ]).catch(error => logger.error('Error initializing published run', {
        error,
        runId: options.created.runId,
    }));

    logRaidCreation(options.client, {
        guildId: options.guild.id,
        organizerId: options.organizerId,
        organizerUsername: options.organizerUsername,
        dungeonName: displayLabel,
        type: 'run',
        runId: options.created.runId,
    }, {
        party: options.party,
        location: options.location,
        description: options.description,
    }).catch(error => logger.error('Failed to log run creation', {
        error,
        runId: options.created.runId,
    }));
}
