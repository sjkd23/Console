// bot/src/interactions/buttons/raids/key-logging.ts
import {
    ButtonInteraction,
    StringSelectMenuInteraction,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    MessageFlags,
    ModalSubmitInteraction,
} from 'discord.js';
import { getJSON, postJSON } from '../../../lib/utilities/http.js';
import {
    buildKeyLoggingPanel,
    buildKeyCountMenu,
    buildCustomNameFeedback,
    KeyLoggingState,
} from '../../../lib/ui/key-logging-panel.js';
import { logKeyLogged } from '../../../lib/logging/raid-logger.js';
import { getMemberRoleIds } from '../../../lib/permissions/permissions.js';
import { createLogger } from '../../../lib/logging/logger.js';
import { findMemberByName } from '../../../lib/utilities/member-helpers.js';

const logger = createLogger('KeyLogging');

// In-memory state store for key logging sessions (keyed by runId)
const keyLoggingSessions = new Map<number, KeyLoggingState>();

/**
 * Initialize and show the key logging panel for a run.
 * Called when the organizer ends a run with key pops.
 */
export async function showKeyLoggingPanel(
    btn: ButtonInteraction,
    runId: number,
    guildId: string,
    dungeonKey: string,
    dungeonLabel: string,
    totalKeys: number
): Promise<void> {
    try {
        // Fetch users who pressed key buttons
        const keyReactionData = await getJSON<{ keyUsers: Record<string, string[]> }>(
            `/runs/${runId}/key-reaction-users`,
            { guildId }
        );

        // Flatten all key reaction users into a single list (deduplicated)
        const keyReactionUsers = Array.from(
            new Set(Object.values(keyReactionData.keyUsers).flat())
        );

        // Fetch usernames/nicknames for display in dropdown
        const userDisplayNames = new Map<string, string>();
        if (btn.guild) {
            for (const userId of keyReactionUsers) {
                try {
                    const member = await btn.guild.members.fetch(userId).catch(() => null);
                    if (member) {
                        // Use server nickname if available, otherwise username
                        userDisplayNames.set(userId, member.displayName || member.user.username);
                    } else {
                        // Fallback to fetching user directly
                        const user = await btn.client.users.fetch(userId).catch(() => null);
                        userDisplayNames.set(userId, user?.username || userId);
                    }
                } catch {
                    userDisplayNames.set(userId, userId); // Fallback to user ID
                }
            }
        }

        // Initialize session state
        const state: KeyLoggingState = {
            runId,
            dungeonKey,
            dungeonLabel,
            totalKeys,
            remainingKeys: totalKeys,
            keyReactionUsers,
            userDisplayNames,
            logs: [],
        };

        keyLoggingSessions.set(runId, state);

        // Build and show the panel
        const { embed, components } = buildKeyLoggingPanel(state);

        // Update the message (this is called after deferUpdate in run-status.ts)
        await btn.editReply({ embeds: [embed], components });

        logger.info('Showed key logging panel', {
            runId,
            guildId,
            totalKeys,
            keyReactionUsers: keyReactionUsers.length,
        });
    } catch (err) {
        logger.error('Failed to show key logging panel', {
            runId,
            guildId,
            error: err instanceof Error ? err.message : String(err),
        });
        await btn.editReply({
            content: 'Failed to load key logging panel. Please use /logkey to manually log keys.',
            embeds: [],
            components: [],
        });
    }
}

/**
 * Handle user selection from dropdown.
 * Shows key count selection menu.
 */
export async function handleKeyLogSelectUser(
    interaction: StringSelectMenuInteraction,
    runId: string
): Promise<void> {
    await interaction.deferUpdate();

    const runIdNum = parseInt(runId);
    const state = keyLoggingSessions.get(runIdNum);

    if (!state) {
        await interaction.editReply({
            content: 'Key logging session expired. Please restart the process.',
            embeds: [],
            components: [],
        });
        return;
    }

    const userId = interaction.values[0];

    // Show key count selection menu
    const { embed, components } = buildKeyCountMenu(
        runIdNum,
        userId,
        state.remainingKeys,
        state.dungeonLabel
    );

    await interaction.editReply({ embeds: [embed], components });
}

/**
 * Handle user selection from custom name search (button click).
 * Shows key count selection menu.
 */
export async function handleKeyLogSelectUserFromButton(
    btn: ButtonInteraction,
    runId: string,
    userId: string
): Promise<void> {
    await btn.deferUpdate();

    const runIdNum = parseInt(runId);
    const state = keyLoggingSessions.get(runIdNum);

    if (!state) {
        await btn.editReply({
            content: 'Key logging session expired. Please restart the process.',
            embeds: [],
            components: [],
        });
        return;
    }

    // Show key count selection menu
    const { embed, components } = buildKeyCountMenu(
        runIdNum,
        userId,
        state.remainingKeys,
        state.dungeonLabel
    );

    await btn.editReply({ embeds: [embed], components });
}

/**
 * Handle key count selection.
 * Logs the keys to the backend and updates the panel.
 */
export async function handleKeyLogKeyCount(
    interaction: StringSelectMenuInteraction,
    runId: string,
    userId: string
): Promise<void> {
    await interaction.deferUpdate();

    const runIdNum = parseInt(runId);
    const state = keyLoggingSessions.get(runIdNum);

    if (!state) {
        await interaction.editReply({
            content: 'Key logging session expired. Please restart the process.',
            embeds: [],
            components: [],
        });
        return;
    }

    const keyCount = parseInt(interaction.values[0]);

    // Validate key count doesn't exceed remaining
    if (keyCount > state.remainingKeys) {
        await interaction.followUp({
            content: `❌ Cannot log ${keyCount} keys. Only ${state.remainingKeys} remaining.`,
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    // Get member for role IDs
    const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
    const actorRoles = member ? getMemberRoleIds(member) : [];

    try {
        // Call backend to log keys
        const result = await postJSON<{
            logged: number;
            new_total: number;
            points_awarded: number;
            user_id: string;
        }>(
            '/quota/log-key',
            {
                actorId: interaction.user.id,
                actorRoles,
                guildId: interaction.guildId!,
                userId: userId,
                dungeonKey: state.dungeonKey,
                amount: keyCount,
            }
        );

        // Fetch username for display
        const user = await interaction.client.users.fetch(userId).catch(() => null);
        const username = user?.username ?? 'Unknown User';

        // Update state
        state.remainingKeys -= keyCount;
        state.logs.push({
            userId: result.user_id,
            username,
            amount: keyCount,
            pointsAwarded: Number(result.points_awarded), // Ensure it's a number
        });

        // Log to raid-log
        if (interaction.guild) {
            try {
                await logKeyLogged(
                    interaction.client,
                    {
                        guildId: interaction.guild.id,
                        organizerId: interaction.user.id,
                        organizerUsername: interaction.user.username,
                        dungeonName: state.dungeonLabel,
                        type: 'run',
                        runId: runIdNum,
                    },
                    userId,
                    username,
                    keyCount,
                    result.points_awarded
                );
            } catch (e) {
                logger.error('Failed to log key logging to raid-log', {
                    runId: runIdNum,
                    userId,
                    error: e instanceof Error ? e.message : String(e),
                });
            }
        }

        // Rebuild and show updated panel
        const { embed, components } = buildKeyLoggingPanel(state);
        await interaction.editReply({ embeds: [embed], components });

        logger.info('Logged keys', {
            runId: runIdNum,
            userId,
            keyCount,
            remainingKeys: state.remainingKeys,
        });
    } catch (err) {
        logger.error('Failed to log keys', {
            runId: runIdNum,
            userId,
            keyCount,
            error: err instanceof Error ? err.message : String(err),
        });
        await interaction.followUp({
            content: '❌ Failed to log keys. Please try again or use /logkey manually.',
            flags: MessageFlags.Ephemeral,
        });
    }
}

/**
 * Handle "Custom Name" button click.
 * Shows modal for entering a custom IGN (in-game name).
 */
export async function handleKeyLogCustomName(btn: ButtonInteraction, runId: string): Promise<void> {
    logger.info('Showing custom name modal', {
        runId,
        userId: btn.user.id,
        replied: btn.replied,
        deferred: btn.deferred,
    });

    const modal = new ModalBuilder()
        .setCustomId(`keylog:customname:modal:${runId}`)
        .setTitle('Enter Player IGN');

    const usernameInput = new TextInputBuilder()
        .setCustomId('username')
        .setLabel('Player In-Game Name (IGN)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g., PlayerName')
        .setRequired(true)
        .setMaxLength(100);

    const row = new ActionRowBuilder<TextInputBuilder>().addComponents(usernameInput);
    modal.addComponents(row);

    try {
        await btn.showModal(modal);
        logger.info('Modal shown successfully', { runId, userId: btn.user.id });
    } catch (error) {
        logger.error('Failed to show modal', {
            runId,
            userId: btn.user.id,
            error: error instanceof Error ? error.message : String(error),
        });
        throw error;
    }
}

/**
 * Handle custom name modal submission.
 * Searches for the user and shows feedback.
 */
export async function handleKeyLogCustomNameModal(
    interaction: ModalSubmitInteraction,
    runId: string
): Promise<void> {
    const searchQuery = interaction.fields.getTextInputValue('username').trim();
    
    logger.info('Processing custom name modal submission', {
        runId,
        userId: interaction.user.id,
        searchQuery,
    });

    await interaction.deferUpdate();

    const runIdNum = parseInt(runId);
    const state = keyLoggingSessions.get(runIdNum);

    if (!state) {
        logger.error('Key logging session not found', { runId: runIdNum });
        await interaction.editReply({
            content: 'Key logging session expired. Please restart the process.',
            embeds: [],
            components: [],
        });
        return;
    }

    // Try to find the user
    let foundUser: { id: string; username: string } | null = null;

    logger.info('Starting user search', { runId: runIdNum, searchQuery });

    // First, check if it's a user ID
    if (/^\d{17,19}$/.test(searchQuery)) {
        logger.info('Search query looks like a user ID, attempting to fetch', { runId: runIdNum, searchQuery });
        try {
            const user = await interaction.client.users.fetch(searchQuery);
            foundUser = { id: user.id, username: user.username };
            logger.info('Found user by ID', { runId: runIdNum, userId: user.id });
        } catch (err) {
            logger.warn('Failed to fetch user by ID', { runId: runIdNum, searchQuery, error: err instanceof Error ? err.message : String(err) });
        }
    }

    // If not found by ID, search guild members by username
    if (!foundUser && interaction.guild) {
        logger.info('Searching guild members by username/displayname', { runId: runIdNum, searchQuery });
        try {
            // Check if we need to fetch members (only if cache is small/empty)
            const cacheSize = interaction.guild.members.cache.size;
            if (cacheSize < 10) {
                logger.info('Guild member cache is small, fetching all members', { runId: runIdNum, guildId: interaction.guild.id, cacheSize });
                await interaction.guild.members.fetch(); // Fetch all members
                logger.info('Guild members fetched', { runId: runIdNum, newCacheSize: interaction.guild.members.cache.size });
            } else {
                logger.info('Using existing guild member cache', { runId: runIdNum, cacheSize });
            }
            
            // Use the improved search function that handles prefix stripping
            const member = findMemberByName(interaction.guild, searchQuery);

            if (member) {
                foundUser = { id: member.id, username: member.user.username };
                logger.info('Found user in guild members', { 
                    runId: runIdNum, 
                    userId: member.id, 
                    displayName: member.displayName,
                    searchQuery 
                });
            } else {
                logger.info('No matching user found in guild members', { runId: runIdNum, searchQuery });
            }
        } catch (err) {
            logger.error('Failed to search guild members', {
                runId: runIdNum,
                searchQuery,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    // Show feedback
    logger.info('Showing custom name search feedback', {
        runId: runIdNum,
        searchQuery,
        foundUser: foundUser ? foundUser.id : null,
    });

    const { embed, components } = buildCustomNameFeedback(
        runIdNum,
        searchQuery,
        foundUser,
        state.dungeonLabel
    );

    try {
        await interaction.editReply({ embeds: [embed], components });
        logger.info('Successfully updated message with search feedback', { runId: runIdNum, searchQuery });
    } catch (error) {
        logger.error('Failed to edit reply with search feedback', {
            runId: runIdNum,
            searchQuery,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

/**
 * Handle "Back" button click.
 * Returns to the main key logging panel.
 */
export async function handleKeyLogBack(btn: ButtonInteraction, runId: string): Promise<void> {
    await btn.deferUpdate();

    const runIdNum = parseInt(runId);
    const state = keyLoggingSessions.get(runIdNum);

    if (!state) {
        await btn.editReply({
            content: 'Key logging session expired. Please restart the process.',
            embeds: [],
            components: [],
        });
        return;
    }

    // Rebuild and show the main panel
    const { embed, components } = buildKeyLoggingPanel(state);
    await btn.editReply({ embeds: [embed], components });
}

/**
 * Handle "Cancel Remaining Keys" button click.
 * Closes the key logging panel without logging remaining keys.
 */
export async function handleKeyLogCancel(btn: ButtonInteraction, runId: string): Promise<void> {
    await btn.deferUpdate();

    const runIdNum = parseInt(runId);
    const state = keyLoggingSessions.get(runIdNum);

    if (state) {
        keyLoggingSessions.delete(runIdNum);
        logger.info('Cancelled key logging', {
            runId: runIdNum,
            remainingKeys: state.remainingKeys,
        });
    }

    await btn.editReply({
        content: '✅ Key logging cancelled. Remaining keys were not logged.',
        embeds: [],
        components: [],
    });
}

/**
 * Handle "Close" button click.
 * Closes the key logging panel after all keys are logged.
 */
export async function handleKeyLogClose(btn: ButtonInteraction, runId: string): Promise<void> {
    await btn.deferUpdate();

    const runIdNum = parseInt(runId);
    keyLoggingSessions.delete(runIdNum);

    await btn.editReply({
        content: '✅ All keys logged successfully. Panel closed.',
        embeds: [],
        components: [],
    });
}

/**
 * Clean up expired key logging sessions (optional, can be called periodically).
 */
export function cleanupExpiredSessions(): void {
    // Sessions older than 1 hour are considered expired
    // Since we don't track timestamps, we can just clear all sessions periodically
    // or implement a more sophisticated cleanup mechanism
    keyLoggingSessions.clear();
}
