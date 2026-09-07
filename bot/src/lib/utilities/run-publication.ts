import {
    AttachmentBuilder,
    type Client,
    type Guild,
    type GuildTextBasedChannel,
    type Message,
    type MessageCreateOptions,
} from 'discord.js';
import { dungeonByCode } from '../../constants/dungeons/dungeon-helpers.js';
import type { DungeonInfo } from '../../constants/dungeons/dungeon-types.js';
import type { CreateRunResponse } from './http.js';
import { getDungeonImage, postJSON } from './http.js';
import { buildRunButtons, buildRunEmbed } from './run-panel-builder.js';
import { resolveDungeonRolePingIds } from './dungeon-role-pings.js';
import { buildRunLifecycleMessageContent } from './run-message-helpers.js';
import { autoJoinOrganizerToRun } from './auto-join-helpers.js';
import { addRunReactions } from './run-reactions.js';
import { sendEarlyLocNotification } from './early-loc-notifier.js';
import { logRaidCreation } from '../logging/raid-logger.js';
import { createLogger } from '../logging/logger.js';
import { syncActiveRunsMirror } from './active-runs-mirror.js';

const logger = createLogger('RunPublication');

export function resolveCreatedRunDungeons(created: CreateRunResponse): DungeonInfo[] {
    return created.selectedDungeons.map(selection => {
        const dungeon = dungeonByCode[selection.dungeonKey];
        if (!dungeon) throw new Error(`Missing bot metadata for dungeon ${selection.dungeonKey}.`);
        return { ...dungeon, dungeonName: selection.dungeonLabel };
    });
}

export function isDungeonImageEligible(created: CreateRunResponse): boolean {
    return created.selectedDungeons.length === 1
        && (created.runKind === 'single' || created.runKind === 'oryx_3')
        && created.selectedDungeons[0].dungeonKey !== 'REALM_DUNGEON';
}

async function publishConfiguredDungeonImage(options: {
    guild: Guild;
    raidChannel: GuildTextBasedChannel;
    created: CreateRunResponse;
}): Promise<void> {
    if (!isDungeonImageEligible(options.created)) return;

    const dungeonKey = options.created.selectedDungeons[0].dungeonKey;
    try {
        const image = await getDungeonImage(options.guild.id, dungeonKey);
        if (!image) return;

        await options.raidChannel.send({
            files: [new AttachmentBuilder(Buffer.from(image.image_base64, 'base64'), {
                name: image.filename,
            })],
            allowedMentions: { parse: [] },
        });
    } catch (error) {
        logger.error('Failed to publish configured dungeon image', {
            error,
            guildId: options.guild.id,
            dungeonKey,
            runId: options.created.runId,
        });
    }
}

async function publishRunPanel(options: {
    guild: Guild;
    raidChannel: GuildTextBasedChannel;
    created: CreateRunResponse;
    message: MessageCreateOptions;
}): Promise<Message<true>> {
    const sent = await options.raidChannel.send(options.message);
    try {
        await postJSON(`/runs/${options.created.runId}/message`, { postMessageId: sent.id }, {
            guildId: options.guild.id,
        });
    } catch (error) {
        await sent.delete().catch(() => undefined);
        throw error;
    }
    await publishConfiguredDungeonImage(options);
    await syncActiveRunsMirror(options.guild.client, options.guild.id, options.created.runId);
    return sent;
}

export async function publishCreatedRun(options: {
    guild: Guild;
    raidChannel: GuildTextBasedChannel;
    created: CreateRunResponse;
} & ({
    organizerId: string;
    description?: string;
    party?: string;
    location?: string;
} | {
    message: MessageCreateOptions;
})): Promise<Message<true>> {
    if ('message' in options) {
        return publishRunPanel({
            guild: options.guild,
            raidChannel: options.raidChannel,
            created: options.created,
            message: options.message,
        });
    }

    const dungeons = resolveCreatedRunDungeons(options.created);
    const rolePingIds = await resolveDungeonRolePingIds(
        options.guild,
        options.created.selectedDungeons.map(dungeon => dungeon.dungeonKey)
    );
    return publishRunPanel({
        guild: options.guild,
        raidChannel: options.raidChannel,
        created: options.created,
        message: {
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
        },
    });
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
