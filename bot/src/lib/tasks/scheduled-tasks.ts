// bot/src/lib/scheduled-tasks.ts
import { Client, EmbedBuilder, type GuildTextBasedChannel, type TextChannel } from 'discord.js';
import { getJSON, patchJSON, postJSON } from '../utilities/http.js';
import { getRolePositions } from '../utilities/http.js';
import { OperationContext } from '../utilities/operation-context.js';
import { createLogger } from '../logging/logger.js';
import { deleteRunRole } from '../utilities/run-role-manager.js';
import { getMemberRoleIds } from '../permissions/permissions.js';
import { updateQuotaPanelsForUser, updateAllQuotaPanels } from '../ui/quota-panel.js';
import { getAllActiveHeadcounts, isHeadcountExpired, unregisterHeadcount } from '../state/active-headcount-tracker.js';
import { clearParticipants } from '../state/headcount-state.js';
import { clearKeyOffers } from '../../interactions/buttons/raids/headcount-key.js';
import { clearHeadcountPanels } from '../state/headcount-panel-tracker.js';

const logger = createLogger('ScheduledTasks');

// ============================================================================
// Type Definitions
// ============================================================================

interface ExpiredRun {
    id: number;
    guild_id: string;
    channel_id: string | null;
    post_message_id: string | null;
    dungeon_label: string;
    organizer_id: string;
    created_at: string;
    auto_end_minutes: number;
    role_id: string | null;
    ping_message_id: string | null;
}

interface ExpiredPunishment {
    guild_id: string;
    user_id: string;
    id: string;
    type: 'suspend' | 'mute';
    moderator_id: string;
    reason: string;
    expires_at: string;
}

interface TaskConfig {
    name: string;
    intervalMinutes: number;
    handler: (client: Client) => Promise<void>;
}

interface TaskStats {
    lastRun: Date | null;
    successCount: number;
    failureCount: number;
    consecutiveFailures: number;
    isRunning: boolean; // Track if task is currently executing
}

// ============================================================================
// Individual Task Handlers
// ============================================================================

/**
 * Check all active runs and automatically end those that have exceeded their auto_end_minutes duration
 * This runs periodically to ensure runs don't stay open indefinitely
 */
async function checkExpiredRuns(client: Client): Promise<void> {
    logger.debug('Starting expired runs check');
    
    // Get list of runs that should be auto-ended
    const response = await getJSON<{ expired: ExpiredRun[] }>('/runs/expired');
    const { expired } = response;

    if (expired.length === 0) {
        logger.debug('No expired runs found');
        return;
    }

    logger.info(`Found ${expired.length} expired runs to auto-end`);

    let successCount = 0;
    let failureCount = 0;

    // Process expired runs in batches to avoid CPU spikes with large numbers
    const BATCH_SIZE = 10;
    for (let i = 0; i < expired.length; i += BATCH_SIZE) {
        const batch = expired.slice(i, i + BATCH_SIZE);
        
        // Process batch in parallel (within reasonable limits)
        const results = await Promise.allSettled(batch.map(async (run) => {
            const guild = client.guilds.cache.get(run.guild_id);
            const organizerMember = guild
                ? await guild.members.fetch(run.organizer_id).catch(() => null)
                : null;

            // End the run via the API
            await patchJSON(`/runs/${run.id}`, {
                actorId: client.user!.id, // Bot acts as the ender
                status: 'ended',
                isAutoEnd: true, // Flag to bypass authorization and allow any->ended transition
                organizerRoles: organizerMember ? getMemberRoleIds(organizerMember) : undefined,
                organizerRolePositions: organizerMember ? getRolePositions(organizerMember) : undefined,
            }, { guildId: run.guild_id });

            // Get the guild for Discord-side cleanup tasks (optional)
            if (!guild) {
                logger.warn(`Auto-ended run but guild not found in cache for Discord cleanup`, {
                    guildId: run.guild_id,
                    runId: run.id
                });
                return;
            }

            logger.info(`Auto-ended run`, {
                runId: run.id,
                dungeon: run.dungeon_label,
                guildId: run.guild_id,
                guildName: guild.name,
                autoEndMinutes: run.auto_end_minutes
            });

            // Auto-update quota panels for the organizer after run ends
            // This awards quota points via the backend transaction and updates the panel
            try {
                await updateQuotaPanelsForUser(
                    client,
                    run.guild_id,
                    run.organizer_id
                );
                logger.debug(`Updated quota panel after auto-end`, {
                    runId: run.id,
                    guildId: run.guild_id,
                    organizerId: run.organizer_id
                });
            } catch (err) {
                logger.warn(`Failed to update quota panel after auto-end`, {
                    runId: run.id,
                    guildId: run.guild_id,
                    organizerId: run.organizer_id,
                    error: err instanceof Error ? err.message : String(err)
                });
                // Don't fail the auto-end if quota panel update fails
            }

            // Delete the run role if it exists
            if (run.role_id) {
                const roleDeleted = await deleteRunRole(guild, run.role_id);
                if (roleDeleted) {
                    logger.debug(`Deleted run role`, { runId: run.id, roleId: run.role_id });
                } else {
                    logger.warn(`Failed to delete run role - role may persist in Discord`, { 
                        runId: run.id, 
                        roleId: run.role_id,
                        guildId: run.guild_id,
                        guildName: guild.name
                    });
                }
            }

            // Delete the ping message if it exists
            if (run.ping_message_id && run.channel_id) {
                try {
                    const channel = await guild.channels.fetch(run.channel_id).catch(() => null);
                    if (channel && channel.isTextBased()) {
                        const pingMessage = await (channel as any).messages.fetch(run.ping_message_id).catch(() => null);
                        if (pingMessage && pingMessage.deletable) {
                            await pingMessage.delete();
                            logger.debug(`Deleted ping message`, { runId: run.id, pingMessageId: run.ping_message_id });
                        }
                    }
                } catch (err) {
                    logger.warn(`Failed to delete ping message`, { runId: run.id, error: err });
                }
            }

            // Update the Discord message if we have the channel and message IDs
            if (run.channel_id && run.post_message_id) {
                try {
                    const channel = await guild.channels.fetch(run.channel_id).catch(() => null) as GuildTextBasedChannel | null;
                    if (channel && channel.isTextBased()) {
                        const message = await channel.messages.fetch(run.post_message_id).catch(() => null);
                        if (message && message.editable) {
                            // Update the embed to show it's ended
                            const embed = new EmbedBuilder()
                                .setTitle(`✅ Run Ended: ${run.dungeon_label}`)
                                .setDescription(`Organizer: <@${run.organizer_id}>\n\n**Status:** Ended`)
                                .setColor(0x808080) // Gray color
                                .setTimestamp();

                            await message.edit({ embeds: [embed], components: [] });
                            logger.debug(`Updated Discord message`, { runId: run.id });
                        }
                    }
                } catch (err) {
                    logger.warn(`Failed to update Discord message`, { 
                        runId: run.id, 
                        error: err instanceof Error ? err.message : String(err)
                    });
                }
            }
        }));
        
        // Count successes and failures
        for (const result of results) {
            if (result.status === 'fulfilled') {
                successCount++;
            } else {
                failureCount++;
                logger.error('Failed to process expired run in batch', {
                    error: result.reason
                });
            }
        }
    }

    logger.info(`Completed expired runs check`, {
        total: expired.length,
        succeeded: successCount,
        failed: failureCount
    });
}

/**
 * Auto-end active headcounts that exceed the configured timeout.
 * Headcounts are in-memory only, so this task handles Discord message cleanup and state teardown.
 */
async function checkExpiredHeadcounts(client: Client): Promise<void> {
    logger.debug('Starting expired headcounts check');

    const activeHeadcounts = getAllActiveHeadcounts();
    if (activeHeadcounts.length === 0) {
        logger.debug('No active headcounts tracked');
        return;
    }

    const now = new Date();
    const expiredHeadcounts = activeHeadcounts.filter(headcount => isHeadcountExpired(headcount, now));

    if (expiredHeadcounts.length === 0) {
        logger.debug('No expired headcounts found');
        return;
    }

    logger.info(`Found ${expiredHeadcounts.length} expired headcounts to auto-end`);

    let successCount = 0;
    let failureCount = 0;

    for (const headcount of expiredHeadcounts) {
        try {
            const guild = client.guilds.cache.get(headcount.guildId);
            if (!guild) {
                unregisterHeadcount(headcount.guildId, headcount.organizerId);
                clearKeyOffers(headcount.messageId);
                clearParticipants(headcount.messageId);
                clearHeadcountPanels(headcount.messageId);

                logger.warn('Expired headcount auto-cleaned without Discord update (guild not cached)', {
                    guildId: headcount.guildId,
                    organizerId: headcount.organizerId,
                    messageId: headcount.messageId,
                });
                successCount++;
                continue;
            }

            const channel = await guild.channels.fetch(headcount.channelId).catch(() => null);
            if (!channel || !channel.isTextBased()) {
                unregisterHeadcount(headcount.guildId, headcount.organizerId);
                clearKeyOffers(headcount.messageId);
                clearParticipants(headcount.messageId);
                clearHeadcountPanels(headcount.messageId);

                logger.warn('Expired headcount auto-cleaned without Discord update (channel unavailable)', {
                    guildId: headcount.guildId,
                    channelId: headcount.channelId,
                    organizerId: headcount.organizerId,
                    messageId: headcount.messageId,
                });
                successCount++;
                continue;
            }

            const message = await channel.messages.fetch(headcount.messageId).catch(() => null);

            if (message && message.editable) {
                const existingEmbed = message.embeds[0];
                const endedEmbed = existingEmbed
                    ? EmbedBuilder.from(existingEmbed)
                        .setTitle(
                            (existingEmbed.title ?? 'Headcount')
                                .replace('🎯', '❌')
                                .replace('Headcount', 'Headcount Ended')
                        )
                        .setColor(0xff0000)
                        .setTimestamp(new Date())
                        .setDescription(`${existingEmbed.description ?? `Organizer: <@${headcount.organizerId}>`}`)
                    : new EmbedBuilder()
                        .setTitle('❌ Headcount Ended')
                        .setColor(0xff0000)
                        .setDescription(`Organizer: <@${headcount.organizerId}>`)
                        .setTimestamp(new Date());

                await message.edit({
                    embeds: [endedEmbed],
                    components: []
                });
            }

            unregisterHeadcount(headcount.guildId, headcount.organizerId);
            clearKeyOffers(headcount.messageId);
            clearParticipants(headcount.messageId);
            clearHeadcountPanels(headcount.messageId);

            logger.info('Auto-ended headcount', {
                guildId: headcount.guildId,
                organizerId: headcount.organizerId,
                messageId: headcount.messageId,
                createdAt: headcount.createdAt.toISOString(),
                autoEndAt: headcount.autoEndAt.toISOString(),
            });

            successCount++;
        } catch (err) {
            failureCount++;
            logger.error('Failed to auto-end expired headcount', {
                guildId: headcount.guildId,
                organizerId: headcount.organizerId,
                messageId: headcount.messageId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    logger.info('Completed expired headcounts check', {
        total: expiredHeadcounts.length,
        succeeded: successCount,
        failed: failureCount,
    });
}

/**
 * Check all guilds for expired suspensions and mutes and remove the respective roles
 * This runs periodically to ensure users don't keep the role after expiration
 */
async function checkExpiredPunishments(client: Client): Promise<void> {
    logger.debug('Starting expired punishments check');
    
    // Get list of expired suspensions and mutes that still need role removal
    const response = await getJSON<{ expired: ExpiredPunishment[] }>('/punishments/expired');
    const { expired } = response;

    if (expired.length === 0) {
        logger.debug('No expired punishments found');
        return;
    }

    logger.info(`Found ${expired.length} expired punishments to process`);

    let successCount = 0;
    let failureCount = 0;

    // Process each expired punishment (suspension or mute)
    for (const punishment of expired) {
        try {
            // Get the guild
            const guild = client.guilds.cache.get(punishment.guild_id);
            if (!guild) {
                logger.warn(`Guild not found`, { 
                    guildId: punishment.guild_id,
                    punishmentId: punishment.id,
                    type: punishment.type
                });
                failureCount++;
                continue;
            }

            // Get guild roles
            const rolesResponse = await getJSON<{ roles: Record<string, string | null> }>(
                `/guilds/${punishment.guild_id}/roles`
            );
            
            // Get the appropriate role based on punishment type
            const roleKey = punishment.type === 'mute' ? 'muted' : 'suspended';
            const roleId = rolesResponse.roles[roleKey];

            if (!roleId) {
                logger.warn(`No ${roleKey} role configured`, { 
                    guildId: punishment.guild_id,
                    punishmentId: punishment.id,
                    type: punishment.type
                });
                failureCount++;
                continue;
            }

            // Get the member
            const member = await guild.members.fetch(punishment.user_id).catch(() => null);
            if (!member) {
                logger.warn(`Member not found in guild (may have left)`, { 
                    userId: punishment.user_id,
                    guildId: punishment.guild_id,
                    punishmentId: punishment.id,
                    type: punishment.type
                });
                // Still mark as processed even if member left
                await postJSON(`/punishments/${punishment.id}/expire`, {
                    processed_by: client.user!.id
                });
                successCount++;
                continue;
            }

            // Check if they have the punishment role
            let roleRemoved = false;
            const roleName = punishment.type === 'mute' ? 'muted' : 'suspended';
            
            if (member.roles.cache.has(roleId)) {
                await member.roles.remove(roleId, `${punishment.type === 'mute' ? 'Mute' : 'Suspension'} expired - ${punishment.id}`);
                logger.info(`Removed ${roleName} role`, {
                    userId: punishment.user_id,
                    userTag: member.user.tag,
                    guildId: punishment.guild_id,
                    guildName: guild.name,
                    punishmentId: punishment.id,
                    type: punishment.type
                });
                roleRemoved = true;
            } else {
                logger.debug(`Member already doesn't have ${roleName} role`, {
                    userId: punishment.user_id,
                    userTag: member.user.tag,
                    guildId: punishment.guild_id,
                    type: punishment.type
                });
            }

            // Mark the punishment as expired/processed in the backend
            await postJSON(`/punishments/${punishment.id}/expire`, {
                processed_by: client.user!.id
            });

            successCount++;

            // Log to punishment_log channel if configured
            try {
                const channelsResponse = await getJSON<{ channels: Record<string, string | null> }>(
                    `/guilds/${punishment.guild_id}/channels`
                );
                const punishmentLogChannelId = channelsResponse.channels.punishment_log;

                if (punishmentLogChannelId) {
                    const logChannel = await guild.channels.fetch(punishmentLogChannelId).catch(() => null);

                    if (logChannel && logChannel.isTextBased()) {
                        const expiresAt = new Date(punishment.expires_at);
                        const title = punishment.type === 'mute' ? '⏰ Mute Expired' : '⏰ Suspension Expired';
                        
                        const logEmbed = new EmbedBuilder()
                            .setTitle(title)
                            .setColor(0x00FF00) // Green
                            .addFields(
                                { name: 'User', value: `<@${punishment.user_id}>`, inline: true },
                                { name: 'Punishment ID', value: punishment.id, inline: true },
                                { name: 'Type', value: punishment.type === 'mute' ? 'Mute' : 'Suspension', inline: true },
                                { name: 'Original Moderator', value: `<@${punishment.moderator_id}>`, inline: true },
                                { name: 'Original Reason', value: punishment.reason, inline: false },
                                { name: 'Expired At', value: `<t:${Math.floor(expiresAt.getTime() / 1000)}:F>`, inline: false },
                                { name: 'Role Removed', value: roleRemoved ? 'Yes' : 'Already removed or member left', inline: false }
                            )
                            .setTimestamp();

                        await (logChannel as TextChannel).send({ embeds: [logEmbed] });
                        logger.debug(`Logged expiration to punishment_log channel`, {
                            guildId: punishment.guild_id,
                            punishmentId: punishment.id,
                            type: punishment.type
                        });
                    }
                }
            } catch (logErr) {
                logger.warn(`Failed to log expiration to punishment_log channel`, { 
                    punishmentId: punishment.id,
                    type: punishment.type,
                    error: logErr instanceof Error ? logErr.message : String(logErr)
                });
            }
        } catch (err) {
            failureCount++;
            logger.error(`Failed to process punishment`, { 
                punishmentId: punishment.id,
                type: punishment.type,
                err 
            });
        }
    }

    logger.info(`Completed expired punishments check`, {
        total: expired.length,
        succeeded: successCount,
        failed: failureCount
    });
}

/**
 * Cleanup expired verification sessions
 * This runs periodically to ensure stale sessions don't accumulate
 */
async function checkExpiredVerificationSessions(client: Client): Promise<void> {
    logger.debug('Starting expired verification sessions check');
    
    try {
        const response = await postJSON<{ expired_count: number }>('/verification/cleanup-expired', {});
        
        if (response.expired_count > 0) {
            logger.info(`Cleaned up expired verification sessions`, {
                count: response.expired_count
            });
        } else {
            logger.debug('No expired verification sessions found');
        }
    } catch (err) {
        logger.error('Failed to cleanup verification sessions', { err });
        throw err; // Re-throw to be caught by wrapper
    }
}

/**
 * Cleanup orphaned run roles
 * This runs periodically to clean up run roles that failed to delete when their run ended.
 * Orphaned roles are roles that exist in Discord but are not associated with any active run.
 */
async function cleanupOrphanedRunRoles(client: Client): Promise<void> {
    logger.debug('Starting orphaned run roles cleanup');
    
    let totalChecked = 0;
    let totalDeleted = 0;
    let totalFailed = 0;
    
    // Process each guild the bot is in
    for (const [guildId, guild] of client.guilds.cache) {
        try {
            // Fetch all active runs for this guild
            const activeRuns = await getJSON<{
                runs: Array<{ id: number; role_id: string | null }>
            }>(`/runs/active`, { guildId });
            
            const activeRoleIds = new Set(
                activeRuns.runs
                    .filter(run => run.role_id)
                    .map(run => run.role_id!)
            );
            
            // Fetch all roles in the guild
            await guild.roles.fetch();
            
            // Find roles that match the run role pattern (username's dungeon)
            const runRolePattern = /'s\s+/; // Pattern: "username's dungeon"
            const potentialRunRoles = guild.roles.cache.filter(role => 
                runRolePattern.test(role.name) && 
                !role.managed && // Exclude bot-managed roles
                role.name.length < 100 // Reasonable length for run roles
            );
            
            totalChecked += potentialRunRoles.size;
            
            // Check each potential run role
            for (const [roleId, role] of potentialRunRoles) {
                // Skip if this role is associated with an active run
                if (activeRoleIds.has(roleId)) {
                    logger.debug('Role is associated with active run, skipping', {
                        guildId,
                        roleId,
                        roleName: role.name
                    });
                    continue;
                }
                
                // This is an orphaned run role - delete it
                try {
                    await role.delete('Cleanup: Orphaned run role (no active run)');
                    totalDeleted++;
                    
                    logger.info('Deleted orphaned run role', {
                        guildId,
                        guildName: guild.name,
                        roleId,
                        roleName: role.name
                    });
                } catch (err) {
                    totalFailed++;
                    logger.warn('Failed to delete orphaned run role', {
                        guildId,
                        roleId,
                        roleName: role.name,
                        error: err instanceof Error ? err.message : String(err)
                    });
                }
            }
        } catch (err) {
            logger.error('Failed to cleanup orphaned roles for guild', {
                guildId,
                guildName: guild.name,
                error: err instanceof Error ? err.message : String(err)
            });
        }
    }
    
    if (totalDeleted > 0 || totalFailed > 0) {
        logger.info('Completed orphaned run roles cleanup', {
            totalChecked,
            totalDeleted,
            totalFailed
        });
    } else {
        logger.debug('No orphaned run roles found');
    }
}

/**
 * Update all quota leaderboard panels
 * This runs periodically to refresh quota panels with current member points and progress.
 * Updates panels in all guilds where quota tracking is configured.
 */
async function updateQuotaPanels(client: Client): Promise<void> {
    logger.debug('Starting quota panels update');
    
    let totalGuilds = 0;
    let totalPanels = 0;
    let totalFailed = 0;
    
    // Process each guild the bot is in
    for (const [guildId, guild] of client.guilds.cache) {
        // Create a new operation context for each guild to cache API calls within guild processing
        const ctx = new OperationContext();
        
        try {
            totalGuilds++;
            
            // Fetch all quota configs for this guild (will be cached in ctx)
            const configs = await ctx.getQuotaConfigs(guildId);
            
            // Only update panels that have a message_id (i.e., panels that exist)
            const activePanels = configs.configs.filter(c => c.panel_message_id);
            
            if (activePanels.length === 0) {
                logger.debug('No active quota panels for guild', { 
                    guildId, 
                    guildName: guild.name 
                });
                continue;
            }
            
            logger.debug(`Updating ${activePanels.length} quota panels for guild`, {
                guildId,
                guildName: guild.name
            });
            
            // Update all panels for this guild (using shared ctx for caching)
            await updateAllQuotaPanels(client, guildId, ctx);
            totalPanels += activePanels.length;
            
            const stats = ctx.getStats();
            logger.info('Updated quota panels for guild', {
                guildId,
                guildName: guild.name,
                panelCount: activePanels.length,
                cacheHits: stats
            });
        } catch (err) {
            totalFailed++;
            logger.error('Failed to update quota panels for guild', {
                guildId,
                guildName: guild.name,
                error: err instanceof Error ? err.message : String(err)
            });
        }
    }
    
    if (totalPanels > 0 || totalFailed > 0) {
        logger.info('Completed quota panels update', {
            totalGuilds,
            totalPanels,
            totalFailed
        });
    } else {
        logger.debug('No quota panels to update');
    }
}

// ============================================================================
// Task Scheduler
// ============================================================================

/**
 * Wrap a task handler with error handling to ensure the scheduler never crashes
 */
function wrapTaskHandler(task: TaskConfig): (client: Client) => Promise<void> {
    return async (client: Client) => {
        try {
            await task.handler(client);
        } catch (err) {
            // Ensure this task never crashes the scheduler
            logger.error(`Critical error in ${task.name}`, { err });
        }
    };
}

/**
 * Start all scheduled tasks
 * This provides a centralized, DRY way to manage periodic bot maintenance tasks
 * 
 * Tasks are defined with their interval and handler, and the scheduler manages
 * running them at the appropriate times. All tasks are wrapped with error handling
 * to ensure one failing task doesn't crash the entire scheduler.
 * 
 * @returns A cleanup function to stop all tasks
 */
export function startScheduledTasks(client: Client): () => void {
    logger.info('Starting scheduled tasks system');

    // Define all scheduled tasks
    const tasks: TaskConfig[] = [
        {
            name: 'Expired Runs',
            intervalMinutes: 5,
            handler: checkExpiredRuns
        },
        {
            name: 'Expired Headcounts',
            intervalMinutes: 5,
            handler: checkExpiredHeadcounts
        },
        {
            name: 'Expired Punishments',
            intervalMinutes: 2,
            handler: checkExpiredPunishments
        },
        {
            name: 'Expired Verification Sessions',
            intervalMinutes: 5,
            handler: checkExpiredVerificationSessions
        },
        {
            name: 'Orphaned Run Roles',
            intervalMinutes: 15,
            handler: cleanupOrphanedRunRoles
        },
        {
            name: 'Quota Panel Updates',
            intervalMinutes: 10,
            handler: updateQuotaPanels
        }
    ];

    // Track task statistics
    const taskStats = new Map<string, TaskStats>();
    tasks.forEach(task => {
        taskStats.set(task.name, {
            lastRun: null,
            successCount: 0,
            failureCount: 0,
            consecutiveFailures: 0,
            isRunning: false
        });
    });

    // Run all tasks immediately on startup
    logger.info('Running initial checks for all tasks');
    tasks.forEach(task => {
        const wrappedHandler = wrapTaskHandler(task);
        wrappedHandler(client)
            .then(() => {
                const stats = taskStats.get(task.name)!;
                stats.lastRun = new Date();
                stats.successCount++;
                stats.consecutiveFailures = 0;
                logger.debug(`Initial ${task.name} check completed successfully`);
            })
            .catch(err => {
                const stats = taskStats.get(task.name)!;
                stats.failureCount++;
                stats.consecutiveFailures++;
                logger.error(`Initial ${task.name} check failed`, { err });
            });
    });

    // Set up intervals for each task
    const intervalIds: NodeJS.Timeout[] = [];
    
    tasks.forEach(task => {
        const wrappedHandler = wrapTaskHandler(task);
        const intervalMs = task.intervalMinutes * 60 * 1000;
        
        logger.info(`Scheduling ${task.name} to run every ${task.intervalMinutes} minutes`);
        
        const intervalId = setInterval(async () => {
            const stats = taskStats.get(task.name)!;
            
            // Overlap protection: skip if previous execution still running
            if (stats.isRunning) {
                logger.warn(`${task.name} is still running, skipping this execution`, {
                    intervalMinutes: task.intervalMinutes,
                    lastRun: stats.lastRun
                });
                return;
            }
            
            stats.isRunning = true;
            
            try {
                await wrappedHandler(client);
                stats.lastRun = new Date();
                stats.successCount++;
                stats.consecutiveFailures = 0;
            } catch (err) {
                stats.failureCount++;
                stats.consecutiveFailures++;
                
                // Log warning if task has failed multiple times consecutively
                if (stats.consecutiveFailures >= 3) {
                    logger.warn(`${task.name} has failed ${stats.consecutiveFailures} times consecutively`, {
                        totalFailures: stats.failureCount,
                        totalSuccesses: stats.successCount,
                        lastRun: stats.lastRun
                    });
                }
            } finally {
                stats.isRunning = false;
            }
        }, intervalMs);
        
        intervalIds.push(intervalId);
    });

    logger.info(`Successfully started ${tasks.length} scheduled tasks`);

    // Return cleanup function to stop all tasks
    return () => {
        logger.info('Stopping all scheduled tasks');
        intervalIds.forEach(id => clearInterval(id));
        
        // Log final statistics
        taskStats.forEach((stats, name) => {
            logger.info(`Final stats for ${name}`, {
                totalRuns: stats.successCount + stats.failureCount,
                successes: stats.successCount,
                failures: stats.failureCount,
                lastRun: stats.lastRun
            });
        });
    };
}
