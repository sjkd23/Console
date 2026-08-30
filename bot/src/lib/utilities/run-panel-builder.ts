/**
 * Universal run panel builder utilities
 * Provides DRY helpers for creating consistent run embeds and button components
 * across all run creation and conversion scenarios.
 */

import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    APIEmbedField
} from 'discord.js';
import { DungeonInfo } from '../../constants/dungeons/dungeon-types.js';
import { getReactionInfo } from '../../constants/emojis/MappedAfkCheckReactions.js';
import { formatKeyLabel, getDungeonEnteredEmoji } from './key-emoji-helpers.js';
import { isO3RealmClosedStage, type O3Stage } from './run-message-helpers.js';
import { classifyRunDungeons, type RunKind } from '../../constants/dungeons/dungeon-taxonomy.js';
import { getPhysicalDungeonKeyOffers } from './dungeon-key-offers.js';

// ============================================================================
// INTERFACES
// ============================================================================

export interface RunEmbedOptions {
    dungeonData: DungeonInfo | readonly DungeonInfo[];
    runKind?: RunKind;
    organizerId: string;
    status: 'starting' | 'live' | 'ended' | 'cancelled';
    description?: string;
    startedAt?: string | null;
    endedAt?: string | null;
    keyWindowEndsAt?: string | null;
    keyPopCount?: number;
    chainAmount?: number | null;
}

export interface RunButtonsOptions {
    runId: number | string;
    dungeonData: DungeonInfo | readonly DungeonInfo[];
    runKind?: RunKind;
    joinLocked?: boolean;
    o3Stage?: O3Stage | null;
}

export interface KeyButtonsResult {
    keyRows: ActionRowBuilder<ButtonBuilder>[];
}

// ============================================================================
// PUBLIC EMBED BUILDERS
// ============================================================================

/**
 * Build a run embed for any status (starting, live, ended, cancelled)
 * This is the universal function that handles all run embed creation
 */
export function buildRunEmbed(options: RunEmbedOptions): EmbedBuilder {
    const dungeons = normalizeDungeons(options.dungeonData);
    const primaryDungeon = dungeons[0];
    const runKind = options.runKind ?? inferRunKind(dungeons);
    const { organizerId, status, description } = options;

    const embed = new EmbedBuilder()
        .setTimestamp(new Date());

    // Apply dungeon theming
    if (dungeons.length === 1 && primaryDungeon.dungeonColors?.length) {
        embed.setColor(primaryDungeon.dungeonColors[0]);
    } else {
        embed.setColor(0x5865F2);
    }
    if (dungeons.length === 1 && primaryDungeon.portalLink?.url) {
        embed.setThumbnail(primaryDungeon.portalLink.url);
    }

    // Build title based on status
    switch (status) {
        case 'starting':
            embed.setTitle(buildRunTitle('starting', dungeons, runKind, options.keyPopCount, options.chainAmount));
            break;
        case 'live':
            embed.setTitle(buildRunTitle('live', dungeons, runKind, options.keyPopCount, options.chainAmount));
            break;
        case 'ended':
            embed.setTitle(buildRunTitle('ended', dungeons, runKind));
            break;
        case 'cancelled':
            embed.setTitle(buildRunTitle('cancelled', dungeons, runKind));
            break;
    }

    // Build description
    embed.setDescription(buildDescription(
        organizerId,
        status,
        options.keyWindowEndsAt,
        options.endedAt,
        options.startedAt,
        primaryDungeon.codeName,
        runKind
    ));

    // Add fields
    const fields = buildEmbedFields(status, dungeons, runKind, description);
    if (fields.length > 0) {
        embed.addFields(fields);
    }

    return embed;
}

/**
 * Transition an existing embed to a new status (e.g., starting -> live -> ended)
 * Preserves existing data while updating status-specific fields
 */
export function transitionRunEmbed(
    originalEmbed: any,
    toStatus: 'live' | 'ended' | 'cancelled',
    options: {
        dungeonKey: string;
        dungeonLabel: string;
        runKind?: RunKind;
        selectedDungeons?: Array<{ dungeonKey: string; dungeonLabel: string }>;
        organizerId: string;
        startedAt?: string | null;
        endedAt?: string | null;
        keyWindowEndsAt?: string | null;
        keyPopCount?: number;
        chainAmount?: number | null;
        description?: string | null;
    }
): EmbedBuilder {
    const embed = EmbedBuilder.from(originalEmbed);
    const titleDungeons = options.selectedDungeons?.length
        ? options.selectedDungeons.map(selection => ({
            codeName: selection.dungeonKey,
            dungeonName: selection.dungeonLabel,
        }))
        : [{ codeName: options.dungeonKey, dungeonName: options.dungeonLabel }];
    const runKind = options.runKind ?? (options.dungeonKey === 'ORYX_3' ? 'oryx_3' : 'single');

    // Update title
    switch (toStatus) {
        case 'live':
            embed.setTitle(buildRunTitle('live', titleDungeons, runKind, options.keyPopCount, options.chainAmount));
            break;
        case 'ended':
            embed.setTitle(buildRunTitle('ended', titleDungeons, runKind));
            break;
        case 'cancelled':
            embed.setTitle(buildRunTitle('cancelled', titleDungeons, runKind));
            break;
    }

    // Update description
    embed.setDescription(buildDescription(
        options.organizerId,
        toStatus,
        options.keyWindowEndsAt,
        options.endedAt,
        options.startedAt,
        options.dungeonKey,
        runKind
    ));

    // Update or clean up fields based on transition
    const data = embed.toJSON();
    const fields = [...(data.fields ?? [])];
    syncDungeonListField(fields, titleDungeons, runKind);

    if (toStatus === 'live') {
        // Merge separate key fields into one
        mergeKeyFields(fields);
        // Remove party, location, classes (shown in message content instead)
        removeFieldsByName(fields, ['party', 'location', 'classes']);
    } else if (toStatus === 'ended' || toStatus === 'cancelled') {
        // Add duration field if we have timestamps
        if (options.startedAt && options.endedAt) {
            addDurationField(fields, options.startedAt, options.endedAt);
        }
        // Add final chain count for non-O3 dungeons
        if (runKind !== 'oryx_3' && (options.keyPopCount ?? 0) > 0) {
            addFinalChainField(fields, options.keyPopCount!, options.chainAmount ?? null);
        }
    }

    return embed.setFields(fields as any);
}

// ============================================================================
// BUTTON BUILDERS
// ============================================================================

/**
 * Build the main action row (Join, Leave, Organizer Panel)
 */
export function buildMainActionRow(
    runId: number | string,
    joinLocked: boolean = false,
    includeJoin: boolean = true
): ActionRowBuilder<ButtonBuilder> {
    const buttons: ButtonBuilder[] = [];

    if (includeJoin) {
        buttons.push(
            new ButtonBuilder()
            .setCustomId(`run:join:${runId}`)
            .setLabel('Join')
            .setStyle(ButtonStyle.Success)
            .setDisabled(joinLocked)
        );
    }

    buttons.push(
        new ButtonBuilder()
            .setCustomId(`run:leave:${runId}`)
            .setLabel('Leave')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`run:org:${runId}`)
            .setLabel('Organizer Panel')
            .setStyle(ButtonStyle.Secondary)
    );

    return new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
}

/**
 * Build key reaction button rows for a dungeon
 * Returns empty array if dungeon has no key reactions
 */
export function buildKeyButtonRows(runId: number | string, dungeonData: DungeonInfo | readonly DungeonInfo[]): ActionRowBuilder<ButtonBuilder>[] {
    const dungeons = normalizeDungeons(dungeonData);
    const keyOffers = getPhysicalDungeonKeyOffers(dungeons);
    if (keyOffers.length === 0) {
        return [];
    }

    const keyButtons: ButtonBuilder[] = [];

    for (const { reaction: keyReaction } of keyOffers) {
        const reactionInfo = getReactionInfo(keyReaction.mapKey);
        const button = new ButtonBuilder()
            .setCustomId(`run:key:${runId}:${keyReaction.mapKey}`)
            .setLabel(formatKeyLabel(keyReaction.mapKey))
            .setStyle(ButtonStyle.Secondary);

        // Add emoji if available
        if (reactionInfo?.emojiInfo?.identifier) {
            button.setEmoji(reactionInfo.emojiInfo.identifier);
        }

        keyButtons.push(button);
    }

    // Split into rows of up to 5 buttons each
    const keyRows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let i = 0; i < keyButtons.length; i += 5) {
        const rowButtons = keyButtons.slice(i, i + 5);
        keyRows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...rowButtons));
    }

    return keyRows;
}

/**
 * Build all button components for a run panel
 * Returns main action row + key button rows
 */
export function buildRunButtons(options: RunButtonsOptions): ActionRowBuilder<ButtonBuilder>[] {
    const { runId, dungeonData, joinLocked = false, o3Stage = null } = options;
    const dungeons = normalizeDungeons(dungeonData);
    const runKind = options.runKind ?? inferRunKind(dungeons);
    const realmIsClosed = runKind === 'oryx_3' && isO3RealmClosedStage(o3Stage);

    const mainRow = buildMainActionRow(runId, joinLocked, !realmIsClosed);
    const keyRows = realmIsClosed ? [] : buildKeyButtonRows(runId, dungeons);

    return [mainRow, ...keyRows];
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

export function buildRunTitle(
    status: 'starting' | 'live' | 'ended' | 'cancelled',
    dungeons: readonly { codeName: string; dungeonName: string }[],
    runKind: RunKind,
    keyPopCount: number = 0,
    chainAmount: number | null = null
): string {
    const dungeonLabel = getRunTitleLabel(dungeons, runKind);
    let chainText = '';

    // Add chain tracking for non-O3 dungeons
    if (runKind !== 'oryx_3' && keyPopCount > 0) {
        if (chainAmount && keyPopCount <= chainAmount) {
            chainText = ` | Chain ${keyPopCount}/${chainAmount}`;
        } else {
            chainText = ` | Chain ${keyPopCount}`;
        }
    }

    if (status === 'starting') return `⏳ Starting Soon: ${dungeonLabel}`;
    if (status === 'ended') return `✅ Ended: ${dungeonLabel}`;
    if (status === 'cancelled') return `❌ Cancelled: ${dungeonLabel}`;
    return `🟢 LIVE: ${dungeonLabel}${chainText}`;
}

export function getRunTitleLabel(
    dungeons: readonly { codeName: string; dungeonName: string }[],
    runKind: RunKind
): string {
    if (runKind === 'realm_clearing') return 'Realm Clearing';
    if (runKind === 'multi_non_exalt') return 'Misc Dungeons';
    if (runKind === 'multi_exalt') return 'Exalt Dungeons';
    return dungeons[0]?.dungeonName ?? 'Unknown Dungeon';
}

function buildDescription(
    organizerId: string,
    status: 'starting' | 'live' | 'ended' | 'cancelled',
    keyWindowEndsAt?: string | null,
    endedAt?: string | null,
    startedAt?: string | null,
    dungeonKey?: string,
    runKind: RunKind = 'single'
): string {
    let desc = `Organizer: <@${organizerId}>`;

    // Add key window for live runs
    if (status === 'live' && keyWindowEndsAt) {
        const endsUnix = Math.floor(new Date(keyWindowEndsAt).getTime() / 1000);
        const now = Math.floor(Date.now() / 1000);

        if (endsUnix > now) {
            const enteredEmoji = getDungeonEnteredEmoji(runKind, dungeonKey ?? 'REALM_DUNGEON');
            desc += `\n\n${enteredEmoji} **Dungeon entered**\nParty join window closes <t:${endsUnix}:R>`;
        }
    }

    // Add end timestamp for ended/cancelled runs
    if ((status === 'ended' || status === 'cancelled') && endedAt) {
        const endedUnix = Math.floor(new Date(endedAt).getTime() / 1000);
        const statusLabel = status === 'cancelled' ? 'Cancelled' : 'Ended';
        desc += `\n${statusLabel} <t:${endedUnix}:R>`;
    }

    return desc;
}

function buildEmbedFields(
    status: 'starting' | 'live' | 'ended' | 'cancelled',
    dungeons: readonly DungeonInfo[],
    runKind: RunKind,
    description?: string
): APIEmbedField[] {
    const fields: APIEmbedField[] = [];

    if (runKind === 'multi_non_exalt' || runKind === 'multi_exalt') {
        fields.push(buildDungeonListField(dungeons));
    }

    // Add Keys field for starting/live runs with key reactions
    if ((status === 'starting' || status === 'live') && dungeons.some(dungeon => dungeon.keyReactions.length > 0)) {
        fields.push({ name: 'Keys', value: 'None', inline: false });
    }

    // Add Organizer Note if description provided
    if (description) {
        fields.push({
            name: 'Organizer Note',
            value: description,
            inline: false
        });
    }

    return fields;
}

function buildDungeonListField(
    dungeons: readonly { dungeonName: string }[]
): APIEmbedField {
    return {
        name: 'Dungeons',
        value: dungeons.map(dungeon => `• ${dungeon.dungeonName}`).join('\n'),
        inline: false,
    };
}

function syncDungeonListField(
    fields: APIEmbedField[],
    dungeons: readonly { dungeonName: string }[],
    runKind: RunKind
): void {
    const existingIndex = fields.findIndex(field => field.name.toLowerCase() === 'dungeons');
    if (runKind !== 'multi_non_exalt' && runKind !== 'multi_exalt') {
        if (existingIndex >= 0) fields.splice(existingIndex, 1);
        return;
    }

    const dungeonField = buildDungeonListField(dungeons);
    if (existingIndex >= 0) {
        fields[existingIndex] = dungeonField;
    } else {
        fields.unshift(dungeonField);
    }
}

function normalizeDungeons(input: DungeonInfo | readonly DungeonInfo[]): DungeonInfo[] {
    return Array.isArray(input) ? [...input] : [input as DungeonInfo];
}

function inferRunKind(dungeons: readonly DungeonInfo[]): RunKind {
    return classifyRunDungeons(dungeons).runKind;
}

function mergeKeyFields(fields: APIEmbedField[]): void {
    const headcountKeysIdx = fields.findIndex(f => (f.name ?? '').includes('Headcount Keys'));
    const raidKeysIdx = fields.findIndex(f => (f.name ?? '').includes('Raid Keys'));

    if (headcountKeysIdx >= 0 || raidKeysIdx >= 0) {
        const mergedKeyLines: string[] = [];

        if (headcountKeysIdx >= 0) {
            const value = fields[headcountKeysIdx].value;
            if (value && value !== 'None') {
                mergedKeyLines.push(value);
            }
        }

        if (raidKeysIdx >= 0) {
            const value = fields[raidKeysIdx].value;
            if (value && value !== 'None') {
                mergedKeyLines.push(value);
            }
        }

        const finalValue = mergedKeyLines.length > 0 ? mergedKeyLines.join('\n') : 'None';

        // Remove separate key fields
        const indicesToRemove = [headcountKeysIdx, raidKeysIdx]
            .filter(i => i >= 0)
            .sort((a, b) => b - a);
        for (const idx of indicesToRemove) {
            fields.splice(idx, 1);
        }

        // Add merged Keys field
        const keysIdx = fields.findIndex(f => (f.name ?? '') === 'Keys');
        if (keysIdx >= 0) {
            fields[keysIdx] = { ...fields[keysIdx], value: finalValue };
        } else {
            fields.unshift({ name: 'Keys', value: finalValue, inline: false });
        }
    }
}

function removeFieldsByName(fields: APIEmbedField[], names: string[]): void {
    const lowerNames = names.map(n => n.toLowerCase());
    for (let i = fields.length - 1; i >= 0; i--) {
        if (lowerNames.includes((fields[i].name ?? '').toLowerCase())) {
            fields.splice(i, 1);
        }
    }
}

function addDurationField(fields: APIEmbedField[], startedAt: string, endedAt: string): void {
    const durationMs = new Date(endedAt).getTime() - new Date(startedAt).getTime();
    const durationMin = Math.floor(durationMs / 60000);
    const durationSec = Math.floor((durationMs % 60000) / 1000);
    
    // Remove existing duration field if present
    const existingIdx = fields.findIndex(f => (f.name ?? '').toLowerCase() === 'duration');
    if (existingIdx >= 0) {
        fields.splice(existingIdx, 1);
    }
    
    // Add duration after description in the embed
    fields.push({
        name: 'Duration',
        value: `${durationMin}m ${durationSec}s`,
        inline: false
    });
}

function addFinalChainField(fields: APIEmbedField[], keyPopCount: number, chainAmount: number | null): void {
    let chainText = `Chain ${keyPopCount}`;
    if (chainAmount && keyPopCount <= chainAmount) {
        chainText = `Chain ${keyPopCount}/${chainAmount}`;
    }
    
    // Add as a field (could also be in description)
    fields.push({
        name: 'Final Chain',
        value: chainText,
        inline: true
    });
}
