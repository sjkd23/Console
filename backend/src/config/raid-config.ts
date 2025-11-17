/**
 * Central raid configuration for the backend.
 *
 * This module defines dungeon metadata and behavior constants
 * (timeouts, limits, etc.) so raid logic doesn't rely on scattered
 * magic numbers.
 *
 * NOTE: Changes here affect all guilds. Keep defaults conservative.
 */

// ============================================================================
// Dungeon Configuration
// ============================================================================

/**
 * Dungeon metadata used by backend for validation, logging, and quota tracking.
 * This should match the dungeon codes used by the bot.
 */
export interface DungeonConfig {
    /** Short code used internally (e.g., 'SHATTERS', 'NEST', 'FUNGAL_CAVERN') */
    code: string;
    /** Display name (e.g., 'Shatters', 'Nest', 'Fungal Cavern') */
    name: string;
    /** Category for grouping/filtering (e.g., 'Exaltation Dungeons', 'Event Dungeons') */
    category: string;
}

/**
 * List of all supported dungeons.
 * This is the single source of truth for dungeon codes on the backend.
 */
export const DUNGEONS: readonly DungeonConfig[] = [
    // Exaltation Dungeons
    { code: 'SHATTERS', name: 'Shatters', category: 'Exaltation Dungeons' },
    { code: 'NEST', name: 'Nest', category: 'Exaltation Dungeons' },
    { code: 'ADVANCED_NEST', name: 'Advanced Nest', category: 'Exaltation Dungeons' },
    { code: 'FUNGAL_CAVERN', name: 'Fungal Cavern', category: 'Exaltation Dungeons' },
    { code: 'CULTIST_HIDEOUT', name: 'Cultist Hideout', category: 'Exaltation Dungeons' },
    { code: 'THE_VOID', name: 'Void', category: 'Exaltation Dungeons' },
    { code: 'LOST_HALLS', name: 'Lost Halls', category: 'Exaltation Dungeons' },
    { code: 'MOONLIGHT VILLAGE', name: 'Moonlight Village', category: 'Exaltation Dungeons' },
    { code: 'STEAMWORKS', name: 'Steamworks', category: 'Exaltation Dungeons' },
    { code: 'ADVANCED STEAMWORKS', name: 'Advanced Steamworks', category: 'Exaltation Dungeons' },

    // Event Dungeons
    { code: 'TOMB_OF_THE_ANCIENTS', name: 'Tomb of the Ancients', category: 'Event Dungeons' },
    { code: 'OCEAN_TRENCH', name: 'Ocean Trench', category: 'Event Dungeons' },
    { code: 'ICE_CAVE', name: 'Ice Cave', category: 'Event Dungeons' },
    { code: 'TOXIC_SEWERS', name: 'Toxic Sewers', category: 'Event Dungeons' },
    { code: 'HAUNTED_CEMETERY', name: 'Haunted Cemetery', category: 'Event Dungeons' },
    { code: 'PARASITE_CHAMBERS', name: 'Parasite Chambers', category: 'Event Dungeons' },
    { code: 'DAVY_JONES_LOCKER', name: "Davy Jones' Locker", category: 'Event Dungeons' },
    { code: 'MOUNTAIN_TEMPLE', name: 'Mountain Temple', category: 'Event Dungeons' },
    { code: 'LAIR_OF_DRACONIS', name: 'Lair of Draconis', category: 'Event Dungeons' },

    // Epic Dungeons
    { code: 'DEADWATER_DOCKS', name: 'Deadwater Docks', category: 'Epic Dungeons' },
    { code: 'WOODLAND_LABYRINTH', name: 'Woodland Labyrinth', category: 'Epic Dungeons' },
    { code: 'CRAWLING_DEPTHS', name: 'Crawling Depths', category: 'Epic Dungeons' },

    // Mini Dungeons
    { code: 'PUPPET_MASTERS_THEATRE', name: "Puppet Master's Theatre", category: 'Mini Dungeons' },
    { code: 'LAIR_OF_SHAITAN', name: 'Lair of Shaitan', category: 'Mini Dungeons' },
    { code: 'PUPPET_MASTERS_ENCORE', name: "Puppet Master's Encore", category: 'Mini Dungeons' },
    { code: 'CNIDARIAN_REEF', name: 'Cnidarian Reef', category: 'Mini Dungeons' },
    { code: 'SECLUDED_THICKET', name: 'Secluded Thicket', category: 'Mini Dungeons' },
    { code: 'HIGH_TECH_TERROR', name: 'High Tech Terror', category: 'Mini Dungeons' },
    { code: 'BATTLE_FOR_THE_NEXUS', name: 'Battle for the Nexus', category: 'Mini Dungeons' },
    { code: 'BELLADONNAS_GARDEN', name: "Belladonna's Garden", category: 'Mini Dungeons' },
    { code: 'ICE_TOMB', name: 'Ice Tomb', category: 'Mini Dungeons' },
    { code: 'MAD_GOD_MAYHEM', name: 'Mad God Mayhem', category: 'Mini Dungeons' },
    { code: 'HIDDEN_INTERREGNUM', name: 'Hidden Interregnum', category: 'Mini Dungeons' },
    { code: 'MACHINE', name: 'Machine', category: 'Mini Dungeons' },

    // Heroic Dungeons
    { code: 'HEROIC_UNDEAD_LAIR', name: 'Heroic Undead Lair', category: 'Heroic Dungeons' },
    { code: 'HEROIC_ABYSS_OF_DEMONS', name: 'Heroic Abyss of Demons', category: 'Heroic Dungeons' },

    // Godland Dungeons
    { code: 'WETLANDS_KEY', name: 'Sulfurous Wetlands', category: 'Godland Dungeons' },
    { code: 'SNAKE_PIT', name: 'Snake Pit', category: 'Godland Dungeons' },
    { code: 'MAGIC_WOODS', name: 'Magic Woods', category: 'Godland Dungeons' },
    { code: 'SPRITE_WORLD', name: 'Sprite World', category: 'Godland Dungeons' },
    { code: 'CAVE_THOUSAND_TREASURES', name: 'Cave of a Thousand Treasures', category: 'Godland Dungeons' },
    { code: 'UNDEAD_LAIR', name: 'Undead Lair', category: 'Godland Dungeons' },
    { code: 'ABYSS_OF_DEMONS', name: 'Abyss of Demons', category: 'Godland Dungeons' },
    { code: 'MANOR_OF_THE_IMMORTALS', name: 'Manor of the Immortals', category: 'Godland Dungeons' },
    { code: 'MAD_LAB', name: 'Mad Lab', category: 'Godland Dungeons' },
    { code: 'CURSED_LIBRARY', name: 'Cursed Library', category: 'Godland Dungeons' },

    // Basic Dungeons
    { code: 'ANCIENT_RUINS', name: 'Ancient Ruins', category: 'Basic Dungeons' },
    { code: 'CANDYLAND_HUNTING_GROUNDS', name: 'Candyland Hunting Grounds', category: 'Basic Dungeons' },
];

/**
 * Map of dungeon codes to their config for O(1) lookup.
 */
export const DUNGEON_BY_CODE: ReadonlyMap<string, DungeonConfig> = new Map(
    DUNGEONS.map(d => [d.code, d])
);

// ============================================================================
// Raid Behavior Configuration
// ============================================================================

/**
 * Raid behavior constants that control timeouts, limits, and other
 * "magic numbers" scattered throughout the backend.
 */
export interface RaidBehaviorConfig {
    /** Default auto-end duration for runs (in minutes). Used when no explicit value provided. */
    defaultAutoEndMinutes: number;

    /** Maximum auto-end duration allowed for runs (in minutes). Prevents extremely long runs. */
    maxAutoEndMinutes: number;

    /** Default key window duration (in seconds). Time window for raiders to join after key pop. */
    defaultKeyWindowSeconds: number;

    /** Maximum key window duration allowed (in seconds). Prevents excessively long windows. */
    maxKeyWindowSeconds: number;
}

/**
 * Central raid behavior configuration.
 * These values are used throughout the backend for run/raid management.
 *
 * Current defaults:
 * - Auto-end: 120 minutes (2 hours) by default, max 1440 (24 hours)
 * - Key window: 25 seconds by default, max 300 (5 minutes)
 */
export const RAID_BEHAVIOR: Readonly<RaidBehaviorConfig> = {
    defaultAutoEndMinutes: 120,   // 2 hours
    maxAutoEndMinutes: 1440,      // 24 hours
    defaultKeyWindowSeconds: 25,  // 25 seconds
    maxKeyWindowSeconds: 300,     // 5 minutes
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if a dungeon code is valid.
 */
export function isValidDungeonCode(code: string): boolean {
    return DUNGEON_BY_CODE.has(code);
}

/**
 * Get a dungeon config by code, or undefined if not found.
 */
export function getDungeonByCode(code: string): DungeonConfig | undefined {
    return DUNGEON_BY_CODE.get(code);
}

/**
 * Get the display name for a dungeon code, or the code itself if not found.
 */
export function getDungeonName(code: string): string {
    return DUNGEON_BY_CODE.get(code)?.name ?? code;
}
