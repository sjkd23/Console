import { Client, EmbedBuilder, User } from 'discord.js';
import { getJSON } from './http.js';
import { createLogger } from '../logging/logger.js';
import { formatKeyLabel } from './key-emoji-helpers.js';

const logger = createLogger('KeyReactorNotifications');

interface KeyReactorInfo {
    user_id: string;
    key_type: string;
}

// Track what party/location was last sent to each user for each run
// Format: `${runId}:${userId}` -> `${party}:${location}`
const sentNotifications = new Map<string, string>();

/**
 * Check if we've already sent this exact party/location to a user for a run
 */
export function hasBeenNotified(runId: string, userId: string, party: string, location: string): boolean {
    const key = `${runId}:${userId}`;
    const lastSent = sentNotifications.get(key);
    const current = `${party}:${location}`;
    return lastSent === current;
}

/**
 * Mark that we've sent this party/location to a user for a run
 */
export function markAsNotified(runId: string, userId: string, party: string, location: string): void {
    const key = `${runId}:${userId}`;
    const value = `${party}:${location}`;
    sentNotifications.set(key, value);
}

/**
 * Fetches all users who have reacted with keys for a specific run
 * @param runId - The run ID to fetch key reactors for
 * @param guildId - The guild ID for API context
 * @returns Object with keyReactors array and organizerIgn
 */
export async function getKeyReactorsForRun(runId: string, guildId: string): Promise<{ 
    keyReactors: KeyReactorInfo[]; 
    organizerIgn: string | null;
}> {
    try {
        const response = await getJSON<{ 
            keyReactors: KeyReactorInfo[];
            organizerIgn: string | null;
        }>(
            `/runs/${runId}/key-reactors`,
            { guildId }
        );
        return {
            keyReactors: response.keyReactors || [],
            organizerIgn: response.organizerIgn || null
        };
    } catch (err) {
        logger.error('Failed to fetch key reactors for run', {
            runId,
            guildId,
            error: err instanceof Error ? err.message : String(err)
        });
        return { keyReactors: [], organizerIgn: null };
    }
}

/**
 * Sends a DM to a user notifying them about party and location information.
 * Fetches organizer IGN from the API if not provided.
 * @param client - Discord client
 * @param userId - The user ID to send the DM to
 * @param guildId - The guild ID (needed to fetch organizer IGN)
 * @param runId - The run ID (needed to fetch organizer IGN)
 * @param dungeonName - The name of the dungeon
 * @param organizerId - The Discord ID of the organizer
 * @param keyTypes - Array of key types the user reacted with
 * @param party - The party name
 * @param location - The location/server
 * @param isUpdate - Whether this is an update (true) or initial notification (false)
 * @returns True if DM was sent successfully, false otherwise
 */
export async function sendKeyReactorDM(
    client: Client,
    userId: string,
    guildId: string,
    runId: string,
    dungeonName: string,
    organizerId: string,
    keyTypes: string[],
    party: string,
    location: string,
    isUpdate: boolean = false
): Promise<boolean> {
    try {
        const user = await client.users.fetch(userId).catch(() => null);
        if (!user) {
            logger.warn('Could not fetch user for key reactor DM', { userId, dungeonName });
            return false;
        }

        // Fetch organizer IGN from API
        const { organizerIgn } = await getKeyReactorsForRun(runId, guildId);

        // Format key types with proper labels
        const keyLabels = keyTypes.map(kt => formatKeyLabel(kt)).join(', ');
        const keyText = keyTypes.length === 1 ? keyLabels : `${keyLabels}`;

        // Build organizer field with mention and IGN
        let organizerField = `<@${organizerId}>`;
        if (organizerIgn) {
            organizerField += ` (IGN: **${organizerIgn}**)`;
        }

        const embed = new EmbedBuilder()
            .setTitle(`${isUpdate ? '📍 Location Update' : '🔑 Key/Rune Confirmation Needed'}`)
            .setDescription(
                isUpdate
                    ? `The party or location has been updated for the **${dungeonName}** run.`
                    : `You have reacted with **${keyText}** for the **${dungeonName}** run.`
            )
            .addFields(
                { name: 'Party', value: party, inline: true },
                { name: 'Location', value: location, inline: true },
                { name: 'Organizer', value: organizerField, inline: false }
            )
            .setColor(isUpdate ? 0xFFA500 : 0x00FF00)
            .setTimestamp();

        if (!isUpdate) {
            const ignText = organizerIgn ? ` Look for **${organizerIgn}** in-game.` : '';
            embed.addFields({
                name: '⚠️ Action Required',
                value: `Please join **${party}** and head to **${location}** as soon as possible to confirm your ${keyTypes.length === 1 ? keyLabels.toLowerCase() : 'keys/runes'} with the organizer.${ignText}`,
                inline: false
            });
        } else {
            const ignText = organizerIgn ? ` Look for **${organizerIgn}** in-game.` : '';
            embed.addFields({
                name: '⚠️ Action Required',
                value: `Please update your location and join **${party}** at **${location}** to confirm your ${keyTypes.length === 1 ? keyLabels.toLowerCase() : 'keys/runes'} with the organizer.${ignText}`,
                inline: false
            });
        }

        await user.send({ embeds: [embed] });
        logger.info('Sent key reactor DM', { userId, dungeonName, keyTypes, isUpdate });
        return true;
    } catch (err) {
        // User might have DMs disabled or blocked the bot
        logger.warn('Failed to send key reactor DM', {
            userId,
            dungeonName,
            error: err instanceof Error ? err.message : String(err)
        });
        return false;
    }
}

/**
 * Notifies all key reactors for a run about party and location information.
 * Automatically deduplicates - won't send the same party/location twice to the same user.
 * @param client - Discord client
 * @param runId - The run ID
 * @param guildId - The guild ID
 * @param dungeonName - The name of the dungeon
 * @param organizerId - The Discord ID of the organizer
 * @param party - The party name
 * @param location - The location/server
 * @param isUpdate - Whether this is an update (true) or initial notification (false)
 * @returns Number of successfully sent DMs
 */
export async function notifyKeyReactors(
    client: Client,
    runId: string,
    guildId: string,
    dungeonName: string,
    organizerId: string,
    party: string,
    location: string,
    isUpdate: boolean = false
): Promise<number> {
    const { keyReactors, organizerIgn } = await getKeyReactorsForRun(runId, guildId);
    
    if (keyReactors.length === 0) {
        logger.debug('No key reactors to notify', { runId, guildId });
        return 0;
    }

    logger.info('Notifying key reactors', { 
        runId, 
        guildId, 
        dungeonName, 
        count: keyReactors.length,
        isUpdate 
    });

    // Group key types by user ID
    const userKeyTypes = new Map<string, string[]>();
    for (const kr of keyReactors) {
        const existing = userKeyTypes.get(kr.user_id) || [];
        existing.push(kr.key_type);
        userKeyTypes.set(kr.user_id, existing);
    }

    let successCount = 0;
    let skippedCount = 0;

    for (const [userId, keyTypes] of userKeyTypes.entries()) {
        // Skip if we've already sent this exact party/location to this user
        if (hasBeenNotified(runId, userId, party, location)) {
            logger.debug('Skipping duplicate notification', { runId, userId, party, location });
            skippedCount++;
            continue;
        }

        const success = await sendKeyReactorDM(
            client,
            userId,
            guildId,
            runId,
            dungeonName,
            organizerId,
            keyTypes,
            party,
            location,
            isUpdate
        );
        
        if (success) {
            successCount++;
            markAsNotified(runId, userId, party, location);
        }
    }

    logger.info('Finished notifying key reactors', { 
        runId, 
        guildId, 
        totalReactors: userKeyTypes.size,
        successfulDMs: successCount,
        skippedDuplicates: skippedCount,
        isUpdate
    });

    return successCount;
}
