import type { Guild } from 'discord.js';
import { getDungeonRolePings } from './http.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('DungeonRolePings');

export function getOrderedDungeonRoleMappingIds(
    mappings: Readonly<Record<string, string | null | undefined>>,
    selectedDungeonKeys: readonly string[]
): string[] {
    const seen = new Set<string>();
    const roleIds: string[] = [];
    for (const dungeonKey of selectedDungeonKeys) {
        const roleId = mappings[dungeonKey];
        if (!roleId || seen.has(roleId)) continue;
        seen.add(roleId);
        roleIds.push(roleId);
    }
    return roleIds;
}

export async function resolveDungeonRolePingIds(
    guild: Guild,
    selectedDungeonKeys: readonly string[]
): Promise<string[]> {
    try {
        const { dungeon_role_pings: mappings } = await getDungeonRolePings(guild.id);
        const resolved: string[] = [];
        for (const roleId of getOrderedDungeonRoleMappingIds(mappings, selectedDungeonKeys)) {
            const role = guild.roles.cache.get(roleId) ?? await guild.roles.fetch(roleId).catch(() => null);
            if (!role) {
                logger.warn('Skipping missing configured dungeon role', { guildId: guild.id, roleId });
                continue;
            }
            resolved.push(roleId);
        }

        return resolved;
    } catch (error) {
        logger.warn('Failed to resolve configured dungeon roles', {
            guildId: guild.id,
            selectedDungeonKeys,
            error: error instanceof Error ? error.message : String(error),
        });
        return [];
    }
}
