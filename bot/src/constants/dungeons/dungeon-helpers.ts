import { DUNGEON_DATA } from './DungeonData';
import type { DungeonInfo } from './dungeon-types';

type DIdx = DungeonInfo & {
    _name: string;
    _code: string;
    _isExalt: boolean;
    _isOryx3: boolean;
};

const ALL: DIdx[] = DUNGEON_DATA.map(d => ({
    ...d,
    _name: d.dungeonName.toLowerCase(),
    _code: d.codeName.toLowerCase(),
    _isExalt: (d.dungeonCategory || '').toLowerCase().includes('exalt'),
    _isOryx3: d.codeName === 'ORYX_3'
}));

export const dungeonByCode: Record<string, DungeonInfo> =
    Object.fromEntries(ALL.map(d => [d.codeName, d]));

// Default list: Oryx 3 first, then Exaltation dungeons sorted A–Z
const DEFAULT_LIST: DungeonInfo[] = (() => {
    const oryx3 = ALL.find(d => d._isOryx3);
    const exalts = ALL
        .filter(d => d._isExalt && !d._isOryx3)
        .sort((a, b) => a.dungeonName.localeCompare(b.dungeonName));
    
    return oryx3 ? [oryx3, ...exalts] : exalts;
})();

export function defaultDungeons(limit = 25): DungeonInfo[] {
    return DEFAULT_LIST.slice(0, limit);
}

/**
 * Calculates search relevance score for a dungeon.
 * Priority order:
 * 1. Oryx 3 gets massive boost
 * 2. Exaltation dungeons get secondary boost
 * 3. Text match quality (prefix > contains)
 * 4. Alphabetical as tiebreaker
 */
function score(d: DIdx, q: string): number {
    let s = 0;
    
    // Text matching score
    if (d._name.startsWith(q)) s += 3;
    else if (d._name.includes(q)) s += 2;

    if (d._code.startsWith(q)) s += 2;
    else if (d._code.includes(q)) s += 1;

    // Priority boosting (only applied if there's a text match)
    if (s > 0) {
        if (d._isOryx3) s += 1000; // Oryx 3 always on top
        else if (d._isExalt) s += 100; // Exalts get second priority
    }

    return s;
}

/**
 * Optimized tiered search that processes high-priority dungeons first
 * and exits early when enough results are found.
 */
export function searchDungeons(query: string, limit = 10): DungeonInfo[] {
    const q = (query || '').trim().toLowerCase();
    if (!q) return defaultDungeons(limit); // Oryx 3 + Exalts when empty

    // Tier 1: Oryx 3 (if it matches)
    const oryx3Match = ALL.find(d => d._isOryx3);
    const oryx3Score = oryx3Match ? score(oryx3Match, q) : 0;
    
    // Tier 2: Exaltation dungeons
    const exaltMatches: Array<[number, DungeonInfo]> = [];
    
    // Tier 3: Regular dungeons
    const regularMatches: Array<[number, DungeonInfo]> = [];
    
    // Single pass through all dungeons, categorizing by tier
    for (const d of ALL) {
        if (d._isOryx3) continue; // Already handled
        
        const s = score(d, q);
        if (s === 0) continue; // No match, skip
        
        if (d._isExalt) {
            exaltMatches.push([s, d]);
        } else {
            regularMatches.push([s, d]);
        }
    }
    
    // Sort each tier independently (smaller arrays = faster sorts)
    const sortFn = (a: [number, DungeonInfo], b: [number, DungeonInfo]) => {
        if (b[0] !== a[0]) return b[0] - a[0];
        return a[1].dungeonName.localeCompare(b[1].dungeonName);
    };
    
    exaltMatches.sort(sortFn);
    regularMatches.sort(sortFn);
    
    // Combine tiers and extract dungeons
    const results: DungeonInfo[] = [];
    
    // Add Oryx 3 if it matched
    if (oryx3Score > 0 && oryx3Match) {
        results.push(oryx3Match);
        if (results.length >= limit) return results;
    }
    
    // Add exalts up to limit
    for (const [, d] of exaltMatches) {
        results.push(d);
        if (results.length >= limit) return results;
    }
    
    // Add regular dungeons up to limit
    for (const [, d] of regularMatches) {
        results.push(d);
        if (results.length >= limit) return results;
    }
    
    return results;
}

/**
 * Get dungeons categorized into groups for UI selection
 */
export function getCategorizedDungeons(): {
    exalt: DungeonInfo[];
    misc1: DungeonInfo[];
    misc2: DungeonInfo[];
} {
    const exalt = ALL
        .filter(d => d._isExalt)
        .sort((a, b) => a.dungeonName.localeCompare(b.dungeonName));
    
    const nonExalt = ALL
        .filter(d => !d._isExalt)
        .sort((a, b) => a.dungeonName.localeCompare(b.dungeonName));
    
    // Split non-exalt dungeons into two groups
    const midpoint = Math.ceil(nonExalt.length / 2);
    const misc1 = nonExalt.slice(0, midpoint);
    const misc2 = nonExalt.slice(midpoint);
    
    return { exalt, misc1, misc2 };
}
