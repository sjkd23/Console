import { z } from 'zod';

export const KeyQuantitySchema = z.number().int().min(1).max(10);

const EXCEPTION_KEY_TYPES: Readonly<Record<string, readonly string[]>> = {
    WETLANDS_KEY: ['WETLANDS_KEY'],
    WOODLAND_LABYRINTH: [],
    REALM_DUNGEON: [],
    LAIR_OF_SHAITAN: ['LAIR_OF_SHAITANS_KEY'],
    HIDDEN_INTERREGNUM: ['HIDDEN_INTERREGUM_KEY'],
    'MOONLIGHT VILLAGE': ['MOONLIGHT_VILLAGE_KEY'],
    'ADVANCED STEAMWORKS': ['ADVANCED_STEAMWORKS_KEY'],
    CULTIST_HIDEOUT: ['LOST_HALLS_KEY'],
    THE_VOID: ['LOST_HALLS_KEY', 'VIAL_OF_PURE_DARKNESS'],
    LOST_HALLS: ['CULT_KEY', 'VOID_KEY', 'VIAL_OF_PURE_DARKNESS'],
    SPECTRAL_PENITENTIARY: ['SPECTRAL_KEY'],
    ICE_CITADEL: ['CITADEL_KEY'],
    ORYX_3: ['WC_INC', 'SHIELD_RUNE', 'SWORD_RUNE', 'HELM_RUNE'],
};

export function getDungeonKeyTypes(dungeonCode: string): readonly string[] {
    if (Object.hasOwn(EXCEPTION_KEY_TYPES, dungeonCode)) return EXCEPTION_KEY_TYPES[dungeonCode];
    return [`${dungeonCode.replaceAll(' ', '_')}_KEY`];
}

export function isKeyTypeForSelectedDungeons(
    keyType: string,
    selectedDungeonCodes: readonly string[]
): boolean {
    return selectedDungeonCodes.some(code => getDungeonKeyTypes(code).includes(keyType));
}
