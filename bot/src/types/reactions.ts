// Type definitions for reaction system

/** Emoji information for reactions */
export interface EmojiInfo {
    isCustom: boolean;
    identifier: string;
}

/** Types of reactions available */
export type ReactionType = 
    | "EARLY_LOCATION"
    | "CLASS"
    | "STATUS_EFFECT"
    | "ITEM"
    | "KEY"
    | "NM_KEY";

/** Individual reaction entry */
export interface AfkCheckReaction {
    type: ReactionType;
    emojiInfo: EmojiInfo;
    name: string;
    isExaltKey: boolean;
}

/** Mapping of reaction keys to their configurations */
export interface IMappedAfkCheckReactions {
    [key: string]: AfkCheckReaction;
}
