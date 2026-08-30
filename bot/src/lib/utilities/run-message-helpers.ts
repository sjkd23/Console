/**
 * Utilities for building run message content
 * Consolidates duplicate logic for formatting public run messages
 */

import type { MessageEditOptions } from 'discord.js';

export type O3Stage = 'closed' | 'miniboss' | 'third_room';

export function isO3RealmClosedStage(o3Stage?: string | null): boolean {
    return o3Stage === 'closed'
        || o3Stage === 'miniboss'
        || o3Stage === 'third_room';
}

export interface RunMessageDungeon {
    dungeonLabel: string;
}

export interface RunMessageContentOptions {
    selectedDungeons: readonly RunMessageDungeon[];
    party?: string | null;
    location?: string | null;
    additionalPingRoleIds?: readonly string[];
    o3Stage?: O3Stage | null;
    includeHere?: boolean;
}

export interface RunLifecycleMessageState {
    selectedDungeons: readonly RunMessageDungeon[];
    party?: string | null;
    location?: string | null;
    o3Stage?: O3Stage | null;
}

export interface RunLifecycleMessageOverrides {
    additionalPingRoleIds?: readonly string[];
    includeHere?: boolean;
}

/**
 * Builds public run message content with dungeon names on the first line and
 * optional party/location or O3 progression details on the second line.
 * @returns Formatted message content string
 */
export function buildRunMessageContent(options: RunMessageContentOptions): string {
    const dungeonNames = options.selectedDungeons
        .map(dungeon => dungeon.dungeonLabel)
        .join(' | ');
    const roleIds = [...new Set(options.additionalPingRoleIds ?? [])];
    const mentions = [
        ...(options.includeHere === false ? [] : ['@here']),
        ...roleIds.map(roleId => `<@&${roleId}>`),
    ];
    const lines = [mentions.length > 0 ? `${mentions.join(' ')} - ${dungeonNames}` : dungeonNames];

    if (isO3RealmClosedStage(options.o3Stage)) {
        lines.push('🔒 **REALM CLOSED** 🔒');
    } else {
        const info: string[] = [];
        if (options.party) info.push(`Party: **${options.party}**`);
        if (options.location) info.push(`Location: **${options.location}**`);
        if (info.length > 0) lines.push(info.join(' | '));
    }

    return lines.join('\n');
}

/** Build public content from persisted lifecycle state, with only ping behavior overridden. */
export function buildRunLifecycleMessageContent(
    state: RunLifecycleMessageState,
    overrides: RunLifecycleMessageOverrides = {}
): string {
    return buildRunMessageContent({
        selectedDungeons: state.selectedDungeons,
        party: state.party,
        location: state.location,
        o3Stage: state.o3Stage,
        additionalPingRoleIds: overrides.additionalPingRoleIds,
        includeHere: overrides.includeHere,
    });
}

/**
 * Content edits retain mention text but never generate fresh notifications.
 * Initial publication deliberately does not use this helper so its pings remain active.
 */
export function buildRunMessageContentEdit(
    content: string
): Pick<MessageEditOptions, 'content' | 'allowedMentions'> {
    return {
        content,
        allowedMentions: { parse: [] },
    };
}
