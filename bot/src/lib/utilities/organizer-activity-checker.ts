/**
 * Utilities for checking organizer's active runs and headcounts
 * Consolidates duplicate logic from run.ts and headcount.ts
 */

import { ChatInputCommandInteraction } from 'discord.js';
import { getActiveRunsByOrganizer, patchJSON, deleteJSON } from './http.js';
import { hasActiveHeadcount, getActiveHeadcount, unregisterHeadcount } from '../state/active-headcount-tracker.js';
import { buildDiscordMessageLink } from './discord-link-helpers.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('OrganizerActivityChecker');

export interface ActiveRunInfo {
    id: number;
    dungeonLabel: string;
    status: 'open' | 'live';
    createdAt: string;
    channelId: string;
    postMessageId: string | null;
}

export interface ActivityCheckResult {
    hasActiveRun: boolean;
    hasActiveHeadcount: boolean;
    errorMessage: string | null;
}

/**
 * Checks if an organizer has any active runs or headcounts and builds appropriate error messages
 * Automatically clears stale activities if their messages no longer exist
 * @param interaction - The command interaction
 * @param guildId - The guild ID to check in
 * @param organizerId - The organizer's user ID
 * @returns Result indicating if organizer has active activities and error message if applicable
 */
export async function checkOrganizerActiveActivities(
    interaction: ChatInputCommandInteraction,
    guildId: string,
    organizerId: string
): Promise<ActivityCheckResult> {
    logger.debug('Checking for active activities', { guildId, organizerId });
    
    // Check for active runs
    try {
        const { activeRuns } = await getActiveRunsByOrganizer(guildId, organizerId);
        
        logger.debug('Active runs check result', { 
            guildId, 
            organizerId, 
            activeRunCount: activeRuns.length,
            activeRuns: activeRuns.map(r => ({ id: r.id, status: r.status, dungeonLabel: r.dungeonLabel }))
        });
        
        if (activeRuns.length > 0) {
            const activeRun = activeRuns[0] as ActiveRunInfo;
            
            logger.debug('Verifying run message exists', {
                guildId,
                organizerId,
                runId: activeRun.id,
                channelId: activeRun.channelId,
                messageId: activeRun.postMessageId
            });
            
            // Verify the run message actually exists
            const messageExists = await verifyMessageExists(
                interaction,
                activeRun.channelId,
                activeRun.postMessageId
            );
            
            logger.debug('Message verification result', {
                guildId,
                organizerId,
                runId: activeRun.id,
                messageExists
            });
            
            if (!messageExists) {
                // Message doesn't exist - clear the stale run
                logger.warn('Active run message no longer exists, clearing stale run', {
                    guildId,
                    organizerId,
                    runId: activeRun.id,
                    channelId: activeRun.channelId,
                    messageId: activeRun.postMessageId
                });
                
                await clearStaleRun(guildId, activeRun.id, organizerId);
                
                // Continue checking for other activities
            } else {
                // Message exists - return error to block creation
                logger.debug('Run message exists, blocking new run creation', {
                    guildId,
                    organizerId,
                    runId: activeRun.id
                });
                
                const errorMessage = buildActiveRunErrorMessage(guildId, activeRun);
                return {
                    hasActiveRun: true,
                    hasActiveHeadcount: false,
                    errorMessage
                };
            }
        }
    } catch (err) {
        logger.error('Failed to check for active runs', {
            guildId,
            organizerId,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined
        });
        // Don't block on API failure - allow the operation to continue
    }

    // Check for active headcount
    if (hasActiveHeadcount(guildId, organizerId)) {
        const activeHeadcount = getActiveHeadcount(guildId, organizerId);
        if (activeHeadcount) {
            // Verify the headcount message actually exists
            const messageExists = await verifyMessageExists(
                interaction,
                activeHeadcount.channelId,
                activeHeadcount.messageId
            );
            
            if (!messageExists) {
                // Message doesn't exist - clear the stale headcount
                logger.warn('Active headcount message no longer exists, clearing stale headcount', {
                    guildId,
                    organizerId,
                    channelId: activeHeadcount.channelId,
                    messageId: activeHeadcount.messageId
                });
                
                unregisterHeadcount(guildId, organizerId);
                
                // Continue - no active activities blocking
            } else {
                // Message exists - return error to block creation
                const errorMessage = buildActiveHeadcountErrorMessage(guildId, activeHeadcount);
                return {
                    hasActiveRun: false,
                    hasActiveHeadcount: true,
                    errorMessage
                };
            }
        }
    }

    return {
        hasActiveRun: false,
        hasActiveHeadcount: false,
        errorMessage: null
    };
}

/**
 * Verifies if a Discord message exists and is accessible
 * @param interaction - The command interaction
 * @param channelId - The channel ID where the message should be
 * @param messageId - The message ID to check
 * @returns true if message exists and is accessible, false otherwise
 */
async function verifyMessageExists(
    interaction: ChatInputCommandInteraction,
    channelId: string | null,
    messageId: string | null
): Promise<boolean> {
    // If we don't have channel or message ID, consider it non-existent
    if (!channelId || !messageId) {
        return false;
    }
    
    try {
        const channel = await interaction.client.channels.fetch(channelId);
        
        if (!channel || !channel.isTextBased()) {
            return false;
        }
        
        // Try to fetch the message with force: true to bypass cache
        const message = await channel.messages.fetch({ message: messageId, force: true });
        
        return !!message;
    } catch (err) {
        // Message fetch failed (404, permissions, etc.) - treat as non-existent
        logger.debug('Message verification failed', {
            channelId,
            messageId,
            error: err instanceof Error ? err.message : String(err)
        });
        return false;
    }
}

/**
 * Clears a stale run by marking it as ended in the backend
 * @param guildId - The guild ID
 * @param runId - The run ID to clear
 * @param organizerId - The organizer's user ID (used to authorize the cancellation)
 */
async function clearStaleRun(guildId: string, runId: number, organizerId: string): Promise<void> {
    try {
        await deleteJSON(
            `/runs/${runId}`,
            {
                actorId: organizerId,
                actorRoles: []
            },
            { guildId }
        );
        
        logger.info('Successfully cleared stale run', { guildId, runId });
    } catch (err) {
        logger.error('Failed to clear stale run', {
            guildId,
            runId,
            error: err instanceof Error ? err.message : String(err)
        });
        // Don't throw - we've done our best to clean up
    }
}

/**
 * Builds error message for when organizer has an active run
 */
function buildActiveRunErrorMessage(guildId: string, activeRun: ActiveRunInfo): string {
    let message = `⚠️ **You already have an active run**\n\n`;
    message += `**Dungeon:** ${activeRun.dungeonLabel}\n`;
    message += `**Status:** ${activeRun.status === 'open' ? '⏳ Starting Soon' : '🔴 Live'}\n`;
    message += `**Created:** <t:${Math.floor(new Date(activeRun.createdAt).getTime() / 1000)}:R>\n\n`;
    
    if (activeRun.channelId && activeRun.postMessageId) {
        const runLink = buildDiscordMessageLink(guildId, activeRun.channelId, activeRun.postMessageId);
        message += `[Jump to Run](${runLink})\n\n`;
    }
    
    message += `Please end or cancel your current run before starting a new one.\n\n`;
    message += `**To end your run:**\n`;
    message += `• Click the "Organizer Panel" button on your active run\n`;
    message += `• Use the "End Run" or "Cancel Run" button`;
    
    return message;
}

/**
 * Builds error message for when organizer has an active headcount
 */
function buildActiveHeadcountErrorMessage(
    guildId: string,
    activeHeadcount: { channelId: string; messageId: string; dungeons: string[]; createdAt: Date }
): string {
    const headcountLink = buildDiscordMessageLink(guildId, activeHeadcount.channelId, activeHeadcount.messageId);
    
    let message = `⚠️ **You have an active headcount**\n\n`;
    message += `**Dungeons:** ${activeHeadcount.dungeons.join(', ')}\n`;
    message += `**Created:** <t:${Math.floor(activeHeadcount.createdAt.getTime() / 1000)}:R>\n\n`;
    message += `[Jump to Headcount](${headcountLink})\n\n`;
    message += `Please end your headcount before starting a run.\n\n`;
    message += `**To end your headcount:**\n`;
    message += `• Click the "Organizer Panel" button on your active headcount\n`;
    message += `• Use the "End Headcount" button`;
    
    return message;
}

/**
 * Builds error message for when organizer tries to create headcount but has active run
 * (Slight variation in wording)
 */
export function buildActiveRunErrorForHeadcount(guildId: string, activeRun: ActiveRunInfo): string {
    let message = `⚠️ **You already have an active run**\n\n`;
    message += `**Dungeon:** ${activeRun.dungeonLabel}\n`;
    message += `**Status:** ${activeRun.status === 'open' ? '⏳ Starting Soon' : '🔴 Live'}\n`;
    message += `**Created:** <t:${Math.floor(new Date(activeRun.createdAt).getTime() / 1000)}:R>\n\n`;
    
    if (activeRun.channelId && activeRun.postMessageId) {
        const runLink = buildDiscordMessageLink(guildId, activeRun.channelId, activeRun.postMessageId);
        message += `[Jump to Run](${runLink})\n\n`;
    }
    
    message += `Please end or cancel your current run before starting a headcount.\n\n`;
    message += `**To end your run:**\n`;
    message += `• Click the "Organizer Panel" button on your active run\n`;
    message += `• Use the "End Run" or "Cancel Run" button`;
    
    return message;
}

/**
 * Builds error message for when organizer tries to create headcount but has active headcount
 * (Slight variation in wording)
 */
export function buildActiveHeadcountErrorForHeadcount(
    guildId: string,
    activeHeadcount: { channelId: string; messageId: string; dungeons: string[]; createdAt: Date }
): string {
    const headcountLink = buildDiscordMessageLink(guildId, activeHeadcount.channelId, activeHeadcount.messageId);
    
    let message = `⚠️ **You already have an active headcount**\n\n`;
    message += `**Dungeons:** ${activeHeadcount.dungeons.join(', ')}\n`;
    message += `**Created:** <t:${Math.floor(activeHeadcount.createdAt.getTime() / 1000)}:R>\n\n`;
    message += `[Jump to Headcount](${headcountLink})\n\n`;
    message += `Please end your current headcount before starting a new one.\n\n`;
    message += `**To end your headcount:**\n`;
    message += `• Click the "Organizer Panel" button on your active headcount\n`;
    message += `• Use the "End Headcount" button`;
    
    return message;
}
