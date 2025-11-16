/**
 * Mapping upsert helpers to reduce massive duplication in guilds.ts
 * The 3 PUT endpoints (roles, channels, dungeon-role-pings) share 150+ lines of identical logic
 */

import { FastifyReply } from 'fastify';
import { query } from '../../db/pool.js';
import { ensureGuildExists, ensureMemberExists } from '../database/database-helpers.js';
import { logAudit } from '../logging/audit.js';

/**
 * Generic options for mapping upsert operations
 */
export interface MappingUpsertOptions<T extends string> {
    guildId: string;
    actorUserId: string;
    updates: Record<string, string | null>;
    validKeys: readonly T[];
    tableName: string;
    keyColumnName: string;
    valueColumnName: string;
    auditEventType: string;
    getCurrentMapping: (guildId: string) => Promise<Record<string, string | null>>;
}

/**
 * Result from mapping upsert operation
 */
export interface MappingUpsertResult {
    currentMapping: Record<string, string | null>;
    warnings: string[];
}

/**
 * Generic function to upsert guild mappings (roles, channels, dungeon-role-pings)
 * Eliminates 150+ lines of duplicate code across 3 endpoints in guilds.ts
 * 
 * @param options - Upsert operation configuration
 * @returns Current mapping and any warnings
 */
export async function upsertGuildMapping<T extends string>(
    options: MappingUpsertOptions<T>
): Promise<MappingUpsertResult> {
    const {
        guildId,
        actorUserId,
        updates,
        validKeys,
        tableName,
        keyColumnName,
        valueColumnName,
        auditEventType,
        getCurrentMapping
    } = options;

    // Get current mapping for audit diff
    const previousMapping = await getCurrentMapping(guildId);

    // Ensure guild and actor exist in database
    await ensureGuildExists(guildId);
    await ensureMemberExists(actorUserId);

    const warnings: string[] = [];

    // Process each provided update
    for (const [key, value] of Object.entries(updates)) {
        // Validate key exists in catalog
        const validKey = validKeys.includes(key as T);
        if (!validKey) {
            warnings.push(`Unknown ${keyColumnName}: ${key}`);
            continue;
        }

        if (value === null) {
            // Delete mapping
            await query(
                `DELETE FROM ${tableName} 
                 WHERE guild_id = $1::bigint AND ${keyColumnName} = $2`,
                [guildId, key]
            );
        } else {
            // Upsert mapping
            await query(
                `INSERT INTO ${tableName} (guild_id, ${keyColumnName}, ${valueColumnName}, updated_at)
                 VALUES ($1::bigint, $2, $3::bigint, NOW())
                 ON CONFLICT (guild_id, ${keyColumnName})
                 DO UPDATE SET ${valueColumnName} = EXCLUDED.${valueColumnName}, updated_at = NOW()`,
                [guildId, key, value]
            );
        }
    }

    // Get updated mapping
    const currentMapping = await getCurrentMapping(guildId);

    // Log audit event with diff
    await logAudit(guildId, actorUserId, auditEventType, guildId, {
        previous: previousMapping,
        current: currentMapping,
        updates,
    });

    return {
        currentMapping,
        warnings
    };
}

/**
 * Simplified version for single-key mappings (like dungeon-role-pings)
 * where you update one key-value pair at a time
 */
export async function upsertSingleMapping(
    guildId: string,
    actorUserId: string,
    key: string,
    value: string | null,
    tableName: string,
    keyColumnName: string,
    valueColumnName: string,
    auditEventType: string,
    getCurrentMapping: (guildId: string) => Promise<Record<string, string | null>>
): Promise<Record<string, string | null>> {
    // Get current mapping for audit diff
    const previousMapping = await getCurrentMapping(guildId);
    const previousValue = previousMapping[key] || null;

    // Ensure guild and actor exist in database
    await ensureGuildExists(guildId);
    await ensureMemberExists(actorUserId);

    if (value === null) {
        // Delete mapping
        await query(
            `DELETE FROM ${tableName} 
             WHERE guild_id = $1::bigint AND ${keyColumnName} = $2`,
            [guildId, key]
        );
    } else {
        // Upsert mapping
        await query(
            `INSERT INTO ${tableName} (guild_id, ${keyColumnName}, ${valueColumnName}, updated_at)
             VALUES ($1::bigint, $2, $3::bigint, NOW())
             ON CONFLICT (guild_id, ${keyColumnName})
             DO UPDATE SET ${valueColumnName} = EXCLUDED.${valueColumnName}, updated_at = NOW()`,
            [guildId, key, value]
        );
    }

    // Get updated mapping
    const currentMapping = await getCurrentMapping(guildId);

    // Log audit event
    await logAudit(guildId, actorUserId, auditEventType, guildId, {
        [keyColumnName]: key,
        previous_value: previousValue,
        current_value: value,
    });

    return currentMapping;
}
