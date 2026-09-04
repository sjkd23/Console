/**
 * Helper functions to automatically add organizers to their runs/headcounts upon creation.
 * This mirrors the behavior of manually clicking the join button.
 */

import { Client, EmbedBuilder, Message, Guild } from 'discord.js';
import { postJSON, getJSON } from './http.js';
import { assignRunRole } from './run-role-manager.js';
import { updateRunParticipation } from './run-embed-helpers.js';
import { logRaidJoin } from '../logging/raid-logger.js';
import { createLogger } from '../logging/logger.js';
import { getInterestedUsers } from '../state/headcount-state.js';
import { getAllOrganizerPanelsForRun } from '../state/organizer-panel-tracker.js';
import { getActiveHeadcountPanels } from '../state/headcount-panel-tracker.js';
import { updateRunOrganizerPanel } from '../../interactions/buttons/raids/organizer-panel.js';
import { updateHeadcountOrganizerPanel } from '../../interactions/buttons/raids/headcount-organizer-panel.js';

const logger = createLogger('AutoJoin');

/**
 * Automatically add the organizer to their run upon creation.
 * This simulates clicking the join button - adds to raiders table, assigns role, updates embed.
 */
export async function autoJoinOrganizerToRun(
    client: Client,
    guild: Guild,
    runMessage: Message,
    runId: number,
    organizerId: string,
    organizerUsername: string,
    dungeonKey: string,
    dungeonLabel: string,
    roleId: string | null
): Promise<void> {
    try {
        // Add organizer to the run in the database
        const result = await postJSON<{ joinCount: number; joined: boolean }>(
            `/runs/${runId}/reactions`,
            {
                userId: organizerId,
                state: 'join'
            },
            { guildId: guild.id }
        );

        // Assign the run role if it exists
        if (roleId) {
            const member = await guild.members.fetch(organizerId).catch(() => null);
            if (member) {
                await assignRunRole(member, roleId);
            }
        }

        // Fetch class counts to update the display
        const classRes = await getJSON<{ classCounts: Record<string, number> }>(
            `/runs/${runId}/classes`,
            { guildId: guild.id }
        ).catch(() => ({ classCounts: {} }));

        // Update the embed to reflect the organizer's participation
        const embeds = runMessage.embeds ?? [];
        if (embeds.length > 0) {
            const first = EmbedBuilder.from(embeds[0]);
            const updated = updateRunParticipation(first, result.joinCount, classRes.classCounts);
            await runMessage.edit({ embeds: [updated, ...embeds.slice(1)] });
        }

        // Log to raid-log thread
        try {
            await logRaidJoin(
                client,
                {
                    guildId: guild.id,
                    organizerId,
                    organizerUsername,
                    dungeonName: dungeonLabel,
                    type: 'run',
                    runId
                },
                organizerId,
                'joined',
                result.joinCount
            );
        } catch (e) {
            logger.error('Failed to log auto-join to raid-log', {
                guildId: guild.id,
                runId,
                error: e instanceof Error ? e.message : String(e)
            });
        }

        // Auto-refresh any active organizer panels for this run
        // This ensures the raider count updates in real-time when the organizer joins
        const activePanels = getAllOrganizerPanelsForRun(runId.toString());
        if (activePanels.length > 0) {
            for (const { handle } of activePanels) {
                try {
                    // Update the panel using the handle (knows how to edit itself correctly)
                    await updateRunOrganizerPanel(handle, runId, guild.id);
                } catch (err) {
                    // Panel might be closed or expired - this is expected behavior
                    logger.debug('Failed to auto-refresh organizer panel after auto-join', {
                        guildId: guild.id,
                        runId,
                        error: err instanceof Error ? err.message : String(err)
                    });
                }
            }
        }

        logger.info('Organizer auto-joined to run', {
            guildId: guild.id,
            runId,
            organizerId,
            joinCount: result.joinCount
        });
    } catch (err) {
        logger.error('Failed to auto-join organizer to run', {
            guildId: guild.id,
            runId,
            organizerId,
            error: err instanceof Error ? err.message : String(err)
        });
        // Don't throw - this is a nice-to-have feature, not critical
    }
}

/**
 * Automatically add the organizer to their headcount upon creation.
 * Preserve the existing organizer auto-interest behavior for every selected dungeon.
 */
export async function autoJoinOrganizerToHeadcount(
    client: Client,
    guild: Guild,
    headcountMessage: Message,
    organizerId: string,
    organizerUsername: string,
    dungeons: ReadonlyArray<{ codeName: string; dungeonName: string }>,
    panelTimestamp: string
): Promise<void> {
    try {
        const embeds = headcountMessage.embeds ?? [];
        if (!embeds.length) {
            logger.warn('No embeds found on headcount message for auto-join', {
                guildId: guild.id,
                messageId: headcountMessage.id
            });
            return;
        }

        const embed = EmbedBuilder.from(embeds[0]);

        for (const dungeon of dungeons) {
            getInterestedUsers(headcountMessage.id, dungeon.codeName).add(organizerId);
        }

        // Log to raid-log thread
        try {
            for (const dungeon of dungeons) {
                const interestedUsers = getInterestedUsers(headcountMessage.id, dungeon.codeName);
                await logRaidJoin(
                    client,
                    {
                        guildId: guild.id,
                        organizerId,
                        organizerUsername,
                        dungeonName: dungeon.dungeonName,
                        type: 'headcount',
                        panelTimestamp
                    },
                    organizerId,
                    'joined',
                    interestedUsers.size
                );
            }
        } catch (e) {
            logger.error('Failed to log headcount auto-join to raid-log', {
                guildId: guild.id,
                messageId: headcountMessage.id,
                error: e instanceof Error ? e.message : String(e)
            });
        }

        // Auto-refresh any active headcount organizer panels for this message
        // This ensures the participant count updates in real-time when the organizer joins
        const activePanels = getActiveHeadcountPanels(headcountMessage.id);
        if (activePanels.length > 0) {
            const dungeonCodes = dungeons.map(dungeon => dungeon.codeName);
            
            // Update all registered panel handles
            for (const handle of activePanels) {
                try {
                    await updateHeadcountOrganizerPanel(handle, headcountMessage, embed, dungeonCodes);
                } catch (err) {
                    // Panel might be closed or expired - this is expected behavior
                    logger.debug('Failed to auto-refresh headcount organizer panel after auto-join', {
                        guildId: guild.id,
                        messageId: headcountMessage.id,
                        error: err instanceof Error ? err.message : String(err)
                    });
                }
            }
        }

        logger.info('Organizer auto-joined to headcount', {
            guildId: guild.id,
            messageId: headcountMessage.id,
            organizerId,
            dungeonCount: dungeons.length
        });
    } catch (err) {
        logger.error('Failed to auto-join organizer to headcount', {
            guildId: guild.id,
            messageId: headcountMessage.id,
            organizerId,
            error: err instanceof Error ? err.message : String(err)
        });
        // Don't throw - this is a nice-to-have feature, not critical
    }
}
