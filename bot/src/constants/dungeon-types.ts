// Discord Snowflake helper (typed string)
export type Snowflake = `${bigint}` | string;

/** Shared reaction entry (used by keyReactions & otherReactions) */
export interface ReactionRequirement {
    mapKey: string;
    maxEarlyLocation: number;
}

/** Simple named link (URL + display name) */
export interface NamedLink {
    url: string;
    name: string;
}

/** Shape of one dungeon entry in DUNGEON_DATA */
export interface DungeonInfo {
    codeName: string;                 // e.g. "FUNGAL_CAVERN"
    dungeonName: string;              // e.g. "Fungal Cavern"
    portalEmojiId: Snowflake;         // emoji ID as string/Snowflake

    keyReactions: ReadonlyArray<ReactionRequirement>;
    otherReactions: ReadonlyArray<ReactionRequirement>;

    portalLink: NamedLink;            // portal image
    bossLinks: ReadonlyArray<NamedLink>;

    dungeonColors: ReadonlyArray<number>; // hex numbers like 0x29c71e
    dungeonCategory: string;              // free-form category label
    isBuiltIn: boolean;
}
