import type { DungeonInfo, ReactionRequirement } from '../../constants/dungeons/dungeon-types.js';
import { isRealmClearingDungeon } from '../../constants/dungeons/dungeon-taxonomy.js';

export interface PhysicalDungeonKeyOffer {
    dungeon: DungeonInfo;
    reaction: ReactionRequirement;
}

/** Return ordered, deduplicated physical key offers for dungeon selections. */
export function getPhysicalDungeonKeyOffers(
    dungeons: readonly DungeonInfo[]
): PhysicalDungeonKeyOffer[] {
    const offers: PhysicalDungeonKeyOffer[] = [];
    const seenMapKeys = new Set<string>();

    for (const dungeon of dungeons) {
        // Realm Clearing has a portal but no physical key.
        if (isRealmClearingDungeon(dungeon.codeName)) continue;

        for (const reaction of dungeon.keyReactions) {
            if (seenMapKeys.has(reaction.mapKey)) continue;
            seenMapKeys.add(reaction.mapKey);
            offers.push({ dungeon, reaction });
        }
    }

    return offers;
}
