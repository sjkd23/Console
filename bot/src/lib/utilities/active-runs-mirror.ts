import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    EmbedBuilder,
    type Client,
    type MessageCreateOptions,
    type MessageEditOptions,
} from 'discord.js';
import { dungeonByCode } from '../../constants/dungeons/dungeon-helpers.js';
import type { DungeonInfo } from '../../constants/dungeons/dungeon-types.js';
import { createLogger } from '../logging/logger.js';
import {
    getActiveRunsSync,
    getGuildChannels,
    getRunDetails,
    setActiveRunsMessage,
    type RunDetails,
} from './http.js';
import { buildRunTitle } from './run-panel-builder.js';

const logger = createLogger('ActiveRunsMirror');
const syncsInFlight = new Map<string, Promise<void>>();

type ActiveRun = Pick<
    RunDetails,
    | 'id'
    | 'status'
    | 'runKind'
    | 'selectedDungeons'
    | 'organizerId'
    | 'party'
    | 'location'
>;

export function isActiveRunsStatus(status: RunDetails['status']): boolean {
    return status === 'open' || status === 'live';
}

export function buildActiveRunsMirror(options: {
    run: ActiveRun;
    dungeons: readonly DungeonInfo[];
    raidPanelUrl: string;
}): Pick<MessageCreateOptions, 'embeds' | 'components' | 'allowedMentions'> {
    return {
        embeds: [buildActiveRunsEmbed(options)],
        components: buildActiveRunsComponents(options.run.id, options.raidPanelUrl),
        allowedMentions: { parse: [] },
    };
}

export function buildActiveRunsEmbed(options: {
    run: ActiveRun;
    dungeons: readonly DungeonInfo[];
    raidPanelUrl: string;
}): EmbedBuilder {
    const { run, dungeons } = options;
    const status = run.status === 'open' ? 'starting' : 'live';
    const statusLabel = run.status === 'open' ? 'Starting Soon' : 'LIVE';
    const displayDungeons = dungeons.map((dungeon, index) => ({
        ...dungeon,
        dungeonName: run.selectedDungeons[index]?.dungeonLabel ?? dungeon.dungeonName,
    }));
    const dungeonLabel = run.selectedDungeons
        .map(dungeon => dungeon.dungeonLabel)
        .join(' | ');
    const primaryDungeon = displayDungeons[0];
    const embed = new EmbedBuilder()
        .setTitle(buildRunTitle(status, displayDungeons, run.runKind))
        .setColor(displayDungeons.length === 1 && primaryDungeon.dungeonColors?.length
            ? primaryDungeon.dungeonColors[0]
            : 0x5865F2)
        .addFields(
            { name: 'Dungeon', value: dungeonLabel, inline: false },
            { name: 'Party', value: run.party ?? 'Not set', inline: true },
            { name: 'Location', value: run.location ?? 'Not set', inline: true },
            { name: 'Status', value: statusLabel, inline: true },
            { name: 'Organizer', value: `<@${run.organizerId}>`, inline: true },
        )
        .setTimestamp(new Date());

    if (displayDungeons.length === 1 && primaryDungeon.portalLink?.url) {
        embed.setThumbnail(primaryDungeon.portalLink.url);
    }

    return embed;
}

export function buildActiveRunsComponents(
    runId: number | string,
    raidPanelUrl: string
): ActionRowBuilder<ButtonBuilder>[] {
    return [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`run:org:${runId}`)
            .setLabel('Organizer Panel')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setLabel('Jump to Raid')
            .setStyle(ButtonStyle.Link)
            .setURL(raidPanelUrl)
    )];
}

function resolveDungeons(run: Pick<RunDetails, 'selectedDungeons'>): DungeonInfo[] | null {
    const dungeons = run.selectedDungeons.map(selection => {
        const dungeon = dungeonByCode[selection.dungeonKey];
        return dungeon ? { ...dungeon, dungeonName: selection.dungeonLabel } : undefined;
    });
    return dungeons.every((dungeon): dungeon is DungeonInfo => dungeon !== undefined)
        ? dungeons
        : null;
}

async function clearPersistedMirror(client: Client, guildId: string, run: RunDetails): Promise<void> {
    if (run.activeRunsChannelId && run.activeRunsMessageId) {
        const channel = await client.channels.fetch(run.activeRunsChannelId).catch(() => null);
        if (channel?.isTextBased() && !channel.isDMBased()) {
            const message = await channel.messages.fetch(run.activeRunsMessageId).catch(() => null);
            if (message?.deletable) await message.delete().catch(() => undefined);
        }
    }
    if (run.activeRunsChannelId || run.activeRunsMessageId) {
        await setActiveRunsMessage(run.id, guildId, null);
    }
}

async function performSync(client: Client, guildId: string, runId: number | string): Promise<void> {
    const run = await getRunDetails(runId, guildId);

    if (!isActiveRunsStatus(run.status)) {
        await clearPersistedMirror(client, guildId, run);
        return;
    }

    const { channels } = await getGuildChannels(guildId);
    const configuredChannelId = channels.active_runs;
    if (!configuredChannelId) {
        await clearPersistedMirror(client, guildId, run);
        return;
    }

    if (!run.channelId || !run.postMessageId) {
        await clearPersistedMirror(client, guildId, run);
        return;
    }

    const raidChannel = await client.channels.fetch(run.channelId).catch(() => null);
    if (!raidChannel?.isTextBased() || raidChannel.isDMBased()) {
        await clearPersistedMirror(client, guildId, run);
        return;
    }
    const raidMessage = await raidChannel.messages.fetch(run.postMessageId).catch(() => null);
    if (!raidMessage) {
        await clearPersistedMirror(client, guildId, run);
        return;
    }

    const dungeons = resolveDungeons(run);
    if (!dungeons) {
        logger.warn('Cannot render Active Runs mirror for unknown dungeon metadata', {
            guildId,
            runId,
            selectedDungeons: run.selectedDungeons,
        });
        await clearPersistedMirror(client, guildId, run);
        return;
    }
    const payload = buildActiveRunsMirror({ run, dungeons, raidPanelUrl: raidMessage.url });

    if (run.activeRunsChannelId === configuredChannelId && run.activeRunsMessageId) {
        const existingChannel = await client.channels.fetch(configuredChannelId).catch(() => null);
        if (existingChannel?.isTextBased() && !existingChannel.isDMBased()) {
            const existingMessage = await existingChannel.messages.fetch(run.activeRunsMessageId).catch(() => null);
            if (existingMessage) {
                const editPayload: MessageEditOptions = { content: null, ...payload };
                await existingMessage.edit(editPayload);
                return;
            }
        }
        await setActiveRunsMessage(run.id, guildId, null);
    } else if (run.activeRunsChannelId || run.activeRunsMessageId) {
        await clearPersistedMirror(client, guildId, run);
    }

    const activeRunsChannel = await client.channels.fetch(configuredChannelId).catch(() => null);
    if (!activeRunsChannel || activeRunsChannel.type !== ChannelType.GuildText) {
        logger.warn('Configured Active Runs channel is unavailable', { guildId, configuredChannelId, runId });
        return;
    }

    const mirror = await activeRunsChannel.send(payload);
    try {
        await setActiveRunsMessage(run.id, guildId, {
            channelId: mirror.channelId,
            messageId: mirror.id,
        });
    } catch (error) {
        await mirror.delete().catch(() => undefined);
        throw error;
    }
}

export async function syncActiveRunsMirror(
    client: Client,
    guildId: string,
    runId: number | string
): Promise<void> {
    const key = `${guildId}:${runId}`;
    const previous = syncsInFlight.get(key) ?? Promise.resolve();
    let sync: Promise<void>;
    sync = previous
        .catch(() => undefined)
        .then(() => performSync(client, guildId, runId))
        .catch(error => logger.error('Failed to synchronize Active Runs mirror', {
            guildId,
            runId,
            error: error instanceof Error ? error.message : String(error),
        }))
        .finally(() => {
            if (syncsInFlight.get(key) === sync) syncsInFlight.delete(key);
        });
    syncsInFlight.set(key, sync);
    return sync;
}

export async function reconcileGuildActiveRuns(client: Client, guildId: string): Promise<void> {
    try {
        const { runs } = await getActiveRunsSync(guildId);
        await Promise.all(runs.map(run => syncActiveRunsMirror(client, run.guildId, run.id)));
    } catch (error) {
        logger.error('Failed to list guild runs for Active Runs reconciliation', {
            guildId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

export async function reconcileAllActiveRuns(client: Client): Promise<void> {
    try {
        const { runs } = await getActiveRunsSync();
        await Promise.all(runs.map(run => syncActiveRunsMirror(client, run.guildId, run.id)));
    } catch (error) {
        logger.error('Failed to list runs for Active Runs reconciliation', {
            error: error instanceof Error ? error.message : String(error),
        });
    }
}
