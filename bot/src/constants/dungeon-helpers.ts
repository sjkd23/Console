import { DUNGEON_DATA } from './DungeonData';
import type { DungeonInfo } from './dungeon-types';

type DIdx = DungeonInfo & {
    _name: string;
    _code: string;
    _isExalt: boolean;
};

const ALL: DIdx[] = DUNGEON_DATA.map(d => ({
    ...d,
    _name: d.dungeonName.toLowerCase(),
    _code: d.codeName.toLowerCase(),
    _isExalt: (d.dungeonCategory || '').toLowerCase().includes('exalt')
}));

export const dungeonByCode: Record<string, DungeonInfo> =
    Object.fromEntries(ALL.map(d => [d.codeName, d]));

// Default = ONLY Exaltation dungeons, sorted A–Z
const DEFAULT_LIST: DungeonInfo[] = ALL
    .filter(d => d._isExalt)
    .sort((a, b) => a.dungeonName.localeCompare(b.dungeonName));

export function defaultDungeons(limit = 25): DungeonInfo[] {
    return DEFAULT_LIST.slice(0, limit);
}

// Lightweight search: prefix > contains; break ties by name A–Z
function score(d: DIdx, q: string): number {
    let s = 0;
    if (d._name.startsWith(q)) s += 3;
    else if (d._name.includes(q)) s += 2;

    if (d._code.startsWith(q)) s += 2;
    else if (d._code.includes(q)) s += 1;

    return s;
}

export function searchDungeons(query: string, limit = 10): DungeonInfo[] {
    const q = (query || '').trim().toLowerCase();
    if (!q) return defaultDungeons(limit); // only Exalts when empty

    return ALL
        .map(d => [score(d, q), d] as const)
        .filter(([s]) => s > 0)
        .sort((a, b) => {
            if (b[0] !== a[0]) return b[0] - a[0];
            return a[1].dungeonName.localeCompare(b[1].dungeonName);
        })
        .slice(0, limit)
        .map(([, d]) => d);
}
