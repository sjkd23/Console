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
import { getJSON, getRunDetails, logRunPhysicalKeys, postJSON } from '../../../lib/utilities/http.js';
import {
    buildKeyLoggingPanel,
    buildKeyCountMenu,
    buildCustomNameFeedback,
    KeyLoggingState,
} from '../../../lib/ui/key-logging-panel.js';
import { logKeyLogged, clearLogThreadCache } from '../../../lib/logging/raid-logger.js';
import { getMemberRoleIds } from '../../../lib/permissions/permissions.js';
import { createLogger } from '../../../lib/logging/logger.js';
import { findMemberByName } from '../../../lib/utilities/member-helpers.js';
import { buttonMutex } from '../../../lib/utilities/button-mutex.js';
import { getLoggableRunDungeons } from '../../../lib/utilities/run-key-logging.js';
import { dungeonByCode } from '../../../constants/dungeons/dungeon-helpers.js';

const logger = createLogger('KeyLogging');

// In-memory state store for key logging sessions (keyed by runId)
const keyLoggingSessions = new Map<number, KeyLoggingState>();

/**
 * Initialize and show the key logging panel for a run.
 * Called when the organizer ends a run with a physical-key allowance.
 */
export async function showKeyLoggingPanel(
    btn: ButtonInteraction,
    runId: number,
    guildId: string,
    legacyO3TotalKeys?: number
): Promise<void> {
    try {
        const run = await getRunDetails(runId, guildId);
        const runBoundAllowance = run.runKind !== 'oryx_3';
        const loggableDungeons = runBoundAllowance
            ? getLoggableRunDungeons(run)
            : [{ dungeonKey: run.dungeonKey, dungeonLabel: run.dungeonLabel }];
        const enteredCount = runBoundAllowance ? run.keyPopCount : (legacyO3TotalKeys ?? 0);
        if (enteredCount < 1 || loggableDungeons.length === 0) {
            throw new Error('This run has no physical key logging allowance.');
        }

        // Fetch users who pressed key buttons
        const keyReactionData = await getJSON<{ keyUsers: Record<string, string[]> }>(
            `/runs/${runId}/key-reaction-users`,
            { guildId }
        );

        // Flatten all key reaction users into a single list (deduplicated)
        const keyReactionUsers = Array.from(
            new Set(Object.values(keyReactionData.keyUsers).flat())
        );
        const keyReactionUsersByDungeon = Object.fromEntries(loggableDungeons.map(dungeon => {
            const keyTypes = dungeonByCode[dungeon.dungeonKey]?.keyReactions.map(reaction => reaction.mapKey) ?? [];
            const users = Array.from(new Set(keyTypes.flatMap(keyType => keyReactionData.keyUsers[keyType] ?? [])));
            return [dungeon.dungeonKey, users];
        }));

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
            organizerId: run.organizerId,
            dungeonLabel: run.selectedDungeons.map(dungeon => dungeon.dungeonLabel).join(' | '),
            enteredCount,
            remainingKeys: enteredCount,
            runBoundAllowance,
            loggableDungeons,
            selectedDungeonKey: loggableDungeons.length === 1 ? loggableDungeons[0].dungeonKey : null,
            keyReactionUsers,
            keyReactionUsersByDungeon,
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
            enteredCount,
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

export async function handleKeyLogSelectDungeon(
    interaction: StringSelectMenuInteraction,
    runId: string
): Promise<void> {
    await interaction.deferUpdate();
    const state = keyLoggingSessions.get(parseInt(runId, 10));
    const selectedDungeonKey = interaction.values[0];
    if (!state || !state.loggableDungeons.some(dungeon => dungeon.dungeonKey === selectedDungeonKey)) {
        await interaction.editReply({
            content: 'Key logging session expired or the dungeon choice is invalid.',
            embeds: [],
            components: [],
        });
        return;
    }

    state.selectedDungeonKey = selectedDungeonKey;
    const { embed, components } = buildKeyLoggingPanel(state);
    await interaction.editReply({ embeds: [embed], components });
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
    const dungeon = state.loggableDungeons.find(candidate => candidate.dungeonKey === state.selectedDungeonKey);
    if (!dungeon) {
        await interaction.editReply({ content: 'Select the physical key dungeon first.', embeds: [], components: [] });
        return;
    }

    // Show key count selection menu
    const { embed, components } = buildKeyCountMenu(
        runIdNum,
        userId,
        state.remainingKeys,
        dungeon.dungeonLabel
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

    const dungeon = state.loggableDungeons.find(candidate => candidate.dungeonKey === state.selectedDungeonKey);
    if (!dungeon) {
        await btn.editReply({ content: 'Select the physical key dungeon first.', embeds: [], components: [] });
        return;
    }

    // Show key count selection menu
    const { embed, components } = buildKeyCountMenu(
        runIdNum,
        userId,
        state.remainingKeys,
        dungeon.dungeonLabel
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
    const lockKey = `run:keylog:${runId}`;
    const lockResult = await buttonMutex.acquire(
        lockKey,
        interaction.user.id,
        interaction.user.username
    );

    if (!lockResult.acquired) {
        await interaction.followUp({
            content: lockResult.message ?? 'Another key logging action is already in progress.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    try {
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
        const selectedDungeon = state.loggableDungeons.find(
            dungeon => dungeon.dungeonKey === state.selectedDungeonKey
        );
        if (!selectedDungeon) {
            await interaction.followUp({
                content: 'Select the physical key dungeon first.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        // Validate key count doesn't exceed remaining while holding the session lock.
        if (keyCount > state.remainingKeys) {
            await interaction.followUp({
                content: `❌ Cannot log ${keyCount} keys. Only ${state.remainingKeys} remaining.`,
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
        const actorRoles = member ? getMemberRoleIds(member) : [];

        try {
            const result = state.runBoundAllowance
                ? await logRunPhysicalKeys({
                    actorId: interaction.user.id,
                    actorRoles,
                    guildId: interaction.guildId!,
                    userId,
                    dungeonKey: selectedDungeon.dungeonKey,
                    amount: keyCount,
                    runId: String(runIdNum),
                    interactionId: interaction.id,
                })
                : await postJSON<{
                    logged: number;
                    new_total: number;
                    points_awarded: number;
                    user_id: string;
                    remaining_allowance?: number;
                    duplicate?: boolean;
                }>(
                    '/quota/log-key',
                    {
                        actorId: interaction.user.id,
                        actorRoles,
                        guildId: interaction.guildId!,
                        userId,
                        dungeonKey: selectedDungeon.dungeonKey,
                        amount: keyCount,
                    }
                );

            const user = await interaction.client.users.fetch(userId).catch(() => null);
            const username = user?.username ?? 'Unknown User';

            if (result.duplicate) {
                state.remainingKeys = result.remaining_allowance ?? state.remainingKeys;
                await interaction.followUp({
                    content: 'This key-log interaction was already recorded; no duplicate key was added.',
                    flags: MessageFlags.Ephemeral,
                });
            } else {
                state.remainingKeys = state.runBoundAllowance
                    ? (result.remaining_allowance ?? state.remainingKeys - result.logged)
                    : state.remainingKeys - result.logged;
                state.logs.push({
                    userId: result.user_id,
                    username,
                    amount: result.logged,
                    pointsAwarded: Number(result.points_awarded),
                    dungeonKey: selectedDungeon.dungeonKey,
                    dungeonLabel: selectedDungeon.dungeonLabel,
                });
                if (state.loggableDungeons.length > 1) state.selectedDungeonKey = null;
            }

            if (interaction.guild && !result.duplicate) {
                try {
                    await logKeyLogged(
                        interaction.client,
                        {
                            guildId: interaction.guild.id,
                            organizerId: interaction.user.id,
                            organizerUsername: interaction.user.username,
                            dungeonName: selectedDungeon.dungeonLabel,
                            type: 'run',
                            runId: runIdNum,
                        },
                        userId,
                        username,
                        result.logged,
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

            const { embed, components } = buildKeyLoggingPanel(state);
            await interaction.editReply({ embeds: [embed], components });

            logger.info('Logged keys', {
                runId: runIdNum,
                userId,
                keyCount: result.logged,
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
    } finally {
        buttonMutex.release(lockKey, interaction.user.id);
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

    const state = keyLoggingSessions.get(parseInt(runId, 10));
    if (!state?.selectedDungeonKey) {
        await btn.reply({ content: 'Select the physical key dungeon first.', flags: MessageFlags.Ephemeral });
        return;
    }

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

    const dungeon = state.loggableDungeons.find(candidate => candidate.dungeonKey === state.selectedDungeonKey);
    if (!dungeon) {
        await interaction.editReply({ content: 'Select the physical key dungeon first.', embeds: [], components: [] });
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
        dungeon.dungeonLabel
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

        // Clear the raid log thread cache now that key logging is complete
        if (btn.guild) {
            clearLogThreadCache({
                guildId: btn.guild.id,
                organizerId: state.organizerId,
                organizerUsername: '',
                dungeonName: state.dungeonLabel,
                type: 'run',
                runId: runIdNum
            });
        }
    }

    await btn.editReply({
        content: '✅ Key logging finished. Previously logged keys were kept; remaining allowance was left unused.',
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
    const state = keyLoggingSessions.get(runIdNum);
    
    // Clear the raid log thread cache now that key logging is complete
    if (state && btn.guild) {
        clearLogThreadCache({
            guildId: btn.guild.id,
            organizerId: state.organizerId,
            organizerUsername: '',
            dungeonName: state.dungeonLabel,
            type: 'run',
            runId: runIdNum
        });
    }
    
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
