import type { DungeonInfo } from '../../constants/dungeons/dungeon-types.js';
import { dungeonByCode } from '../../constants/dungeons/dungeon-helpers.js';
import {
    classifyRunDungeons,
    isRealmClearingDungeon,
} from '../../constants/dungeons/dungeon-taxonomy.js';

export type HeadcountConversionMode = 'direct' | 'select';
export type HeadcountConversionEndReason = 'confirmed' | 'cancelled' | 'timeout';

export interface TransferredKeyOffer {
    userId: string;
    keyType: string;
    quantity: number;
}

export interface HeadcountConversionFreshness {
    expectedMessageId: string;
    expectedChannelId: string;
    activeHeadcount: {
        messageId: string;
        channelId: string;
        dungeonCodes: readonly string[];
    } | null;
    originalDungeonCodes: readonly string[];
    selectedDungeonCodes: readonly string[];
    hasActiveRun: boolean;
}

export type ConvertedHeadcountRetirement = 'deleted' | 'closed' | 'still_active';

export const MULTI_DUNGEON_HEADCOUNT_TITLE = '🎯 Headcount - Multiple Dungeons';

export function getHeadcountConversionMode(
    availableDungeons: readonly DungeonInfo[]
): HeadcountConversionMode {
    return availableDungeons.length === 1 ? 'direct' : 'select';
}

export function buildHeadcountConversionOptions(
    availableDungeons: readonly DungeonInfo[],
    selectedCodes: readonly string[]
) {
    const selected = new Set(selectedCodes);
    return availableDungeons.map(dungeon => ({
        label: dungeon.dungeonName,
        value: dungeon.codeName,
        description: dungeon.dungeonCategory || undefined,
        default: selected.has(dungeon.codeName),
    }));
}

export function validateHeadcountRunSubset(
    availableDungeons: readonly DungeonInfo[],
    selectedCodes: readonly string[]
): string | null {
    if (selectedCodes.length === 0) return 'Choose at least one dungeon.';
    if (selectedCodes.length > Math.min(5, availableDungeons.length)) {
        return 'Choose no more than five available dungeons.';
    }

    const availableCodes = new Set(availableDungeons.map(dungeon => dungeon.codeName));
    if (new Set(selectedCodes).size !== selectedCodes.length) return 'Duplicate dungeons are not allowed.';
    if (selectedCodes.some(code => !availableCodes.has(code))) {
        return 'Choose only dungeons from this headcount.';
    }

    try {
        classifyRunDungeons(selectedCodes.map(code => dungeonByCode[code]));
        return null;
    } catch (error) {
        return error instanceof Error ? error.message : 'Invalid run selection.';
    }
}

export function validateHeadcountConversionFreshness(
    state: HeadcountConversionFreshness,
    availableDungeons: readonly DungeonInfo[]
): string | null {
    if (!state.activeHeadcount
        || state.activeHeadcount.messageId !== state.expectedMessageId
        || state.activeHeadcount.channelId !== state.expectedChannelId) {
        return 'This headcount is no longer active. Reopen the current panel before converting.';
    }
    if (state.hasActiveRun) {
        return 'The organizer already has an active run. End it before converting this headcount.';
    }
    if (!sameOrderedCodes(state.activeHeadcount.dungeonCodes, state.originalDungeonCodes)) {
        return 'This headcount changed while the conversion selector was open. Reopen the organizer panel.';
    }

    return validateHeadcountRunSubset(availableDungeons, state.selectedDungeonCodes);
}

export function getConversionOrganizerUsername(
    organizerId: string,
    member: { id: string; user: { username: string } }
): string {
    if (member.id !== organizerId) throw new Error('Fetched member does not match the headcount organizer.');
    return member.user.username;
}

export async function retireConvertedHeadcountMessage(message: {
    delete(): Promise<unknown>;
    edit(options: { content: string; embeds: []; components: []; allowedMentions: { parse: [] } }): Promise<unknown>;
}): Promise<ConvertedHeadcountRetirement> {
    try {
        await message.delete();
        return 'deleted';
    } catch {
        try {
            await message.edit({
                content: '✅ This headcount was converted to a run.',
                embeds: [],
                components: [],
                allowedMentions: { parse: [] },
            });
            return 'closed';
        } catch {
            return 'still_active';
        }
    }
}

export function getHeadcountConversionEndState(reason: HeadcountConversionEndReason): {
    preserveHeadcount: boolean;
    message: string | null;
} {
    if (reason === 'confirmed') return { preserveHeadcount: false, message: null };
    return {
        preserveHeadcount: true,
        message: reason === 'cancelled'
            ? 'Conversion cancelled. The headcount remains active.'
            : 'Conversion timed out. The headcount remains active.',
    };
}

export function collectSelectedDungeonKeyOffers(
    keyOffers: ReadonlyMap<string, ReadonlyMap<string, ReadonlyMap<string, number>>>,
    selectedDungeonCodes: readonly string[]
): TransferredKeyOffer[] {
    const uniqueOffers = new Map<string, TransferredKeyOffer>();
    for (const dungeonCode of selectedDungeonCodes) {
        // Realm Clearing has no physical key, including in legacy headcount state.
        if (isRealmClearingDungeon(dungeonCode)) continue;
        for (const [mapKey, userQuantities] of keyOffers.get(dungeonCode) ?? []) {
            for (const [userId, quantity] of userQuantities) {
                // Shared keys can appear under multiple selected dungeons. One current
                // context/user/key quantity is transferred, with the later occurrence winning.
                uniqueOffers.set(`${userId}:${mapKey}`, { userId, keyType: mapKey, quantity });
            }
        }
    }
    return [...uniqueOffers.values()];
}

function sameOrderedCodes(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((code, index) => code === right[index]);
}
