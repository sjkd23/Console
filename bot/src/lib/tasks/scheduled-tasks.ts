// bot/src/lib/scheduled-tasks.ts
import { Client, EmbedBuilder, type GuildTextBasedChannel, type TextChannel } from 'discord.js';
import { getJSON, patchJSON, postJSON } from '../utilities/http.js';
import { createLogger } from '../logging/logger.js';
import { deleteRunRole } from '../utilities/run-role-manager.js';

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

interface ExpiredSuspension {
    guild_id: string;
    user_id: string;
    id: string;
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

    // Process each expired run
    for (const run of expired) {
        try {
            // Get the guild
            const guild = client.guilds.cache.get(run.guild_id);
            if (!guild) {
                logger.warn(`Guild not found for run`, { 
                    guildId: run.guild_id, 
                    runId: run.id 
                });
                failureCount++;
                continue;
            }

            // End the run via the API
            await patchJSON(`/runs/${run.id}`, {
                actorId: client.user!.id, // Bot acts as the ender
                status: 'ended',
                isAutoEnd: true // Flag to bypass authorization and allow any->ended transition
            });

            logger.info(`Auto-ended run`, {
                runId: run.id,
                dungeon: run.dungeon_label,
                guildId: run.guild_id,
                guildName: guild.name,
                autoEndMinutes: run.auto_end_minutes
            });

            successCount++;

            // Delete the run role if it exists
            if (run.role_id) {
                await deleteRunRole(guild, run.role_id);
                logger.debug(`Deleted run role`, { runId: run.id, roleId: run.role_id });
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
                                .setDescription(`Organizer: <@${run.organizer_id}>\n\n**Status:** Auto-ended (exceeded ${run.auto_end_minutes} minutes)`)
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
        } catch (err) {
            failureCount++;
            logger.error(`Failed to auto-end run`, { 
                runId: run.id, 
                err 
            });
        }
    }

    logger.info(`Completed expired runs check`, {
        total: expired.length,
        succeeded: successCount,
        failed: failureCount
    });
}

/**
 * Check all guilds for expired suspensions and remove the suspended role
 * This runs periodically to ensure users don't keep the role after expiration
 */
async function checkExpiredSuspensions(client: Client): Promise<void> {
    logger.debug('Starting expired suspensions check');
    
    // Get list of expired suspensions that still need role removal
    const response = await getJSON<{ expired: ExpiredSuspension[] }>('/punishments/expired');
    const { expired } = response;

    if (expired.length === 0) {
        logger.debug('No expired suspensions found');
        return;
    }

    logger.info(`Found ${expired.length} expired suspensions to process`);

    let successCount = 0;
    let failureCount = 0;

    // Process each expired suspension
    for (const suspension of expired) {
        try {
            // Get the guild
            const guild = client.guilds.cache.get(suspension.guild_id);
            if (!guild) {
                logger.warn(`Guild not found`, { 
                    guildId: suspension.guild_id,
                    suspensionId: suspension.id 
                });
                failureCount++;
                continue;
            }

            // Get guild roles
            const rolesResponse = await getJSON<{ roles: Record<string, string | null> }>(
                `/guilds/${suspension.guild_id}/roles`
            );
            const suspendedRoleId = rolesResponse.roles.suspended;

            if (!suspendedRoleId) {
                logger.warn(`No suspended role configured`, { 
                    guildId: suspension.guild_id,
                    suspensionId: suspension.id 
                });
                failureCount++;
                continue;
            }

            // Get the member
            const member = await guild.members.fetch(suspension.user_id).catch(() => null);
            if (!member) {
                logger.warn(`Member not found in guild (may have left)`, { 
                    userId: suspension.user_id,
                    guildId: suspension.guild_id,
                    suspensionId: suspension.id 
                });
                // Still mark as processed even if member left
                await postJSON(`/punishments/${suspension.id}/expire`, {
                    processed_by: client.user!.id
                });
                successCount++;
                continue;
            }

            // Check if they have the suspended role
            let roleRemoved = false;
            if (member.roles.cache.has(suspendedRoleId)) {
                await member.roles.remove(suspendedRoleId, `Suspension expired - ${suspension.id}`);
                logger.info(`Removed suspended role`, {
                    userId: suspension.user_id,
                    userTag: member.user.tag,
                    guildId: suspension.guild_id,
                    guildName: guild.name,
                    suspensionId: suspension.id
                });
                roleRemoved = true;
            } else {
                logger.debug(`Member already doesn't have suspended role`, {
                    userId: suspension.user_id,
                    userTag: member.user.tag,
                    guildId: suspension.guild_id
                });
            }

            // Mark the suspension as expired/processed in the backend
            await postJSON(`/punishments/${suspension.id}/expire`, {
                processed_by: client.user!.id
            });

            successCount++;

            // Log to punishment_log channel if configured
            try {
                const channelsResponse = await getJSON<{ channels: Record<string, string | null> }>(
                    `/guilds/${suspension.guild_id}/channels`
                );
                const punishmentLogChannelId = channelsResponse.channels.punishment_log;

                if (punishmentLogChannelId) {
                    const logChannel = await guild.channels.fetch(punishmentLogChannelId).catch(() => null);

                    if (logChannel && logChannel.isTextBased()) {
                        const expiresAt = new Date(suspension.expires_at);
                        
                        const logEmbed = new EmbedBuilder()
                            .setTitle('⏰ Suspension Expired')
                            .setColor(0x00FF00) // Green
                            .addFields(
                                { name: 'User', value: `<@${suspension.user_id}>`, inline: true },
                                { name: 'Punishment ID', value: suspension.id, inline: true },
                                { name: 'Original Moderator', value: `<@${suspension.moderator_id}>`, inline: true },
                                { name: 'Original Reason', value: suspension.reason, inline: false },
                                { name: 'Expired At', value: `<t:${Math.floor(expiresAt.getTime() / 1000)}:F>`, inline: false },
                                { name: 'Role Removed', value: roleRemoved ? 'Yes' : 'Already removed or member left', inline: false }
                            )
                            .setTimestamp();

                        await (logChannel as TextChannel).send({ embeds: [logEmbed] });
                        logger.debug(`Logged expiration to punishment_log channel`, {
                            guildId: suspension.guild_id,
                            suspensionId: suspension.id
                        });
                    }
                }
            } catch (logErr) {
                logger.warn(`Failed to log expiration to punishment_log channel`, { 
                    suspensionId: suspension.id,
                    error: logErr instanceof Error ? logErr.message : String(logErr)
                });
            }
        } catch (err) {
            failureCount++;
            logger.error(`Failed to process suspension`, { 
                suspensionId: suspension.id,
                err 
            });
        }
    }

    logger.info(`Completed expired suspensions check`, {
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
            name: 'Expired Suspensions',
            intervalMinutes: 2,
            handler: checkExpiredSuspensions
        },
        {
            name: 'Expired Verification Sessions',
            intervalMinutes: 5,
            handler: checkExpiredVerificationSessions
        }
    ];

    // Track task statistics
    const taskStats = new Map<string, TaskStats>();
    tasks.forEach(task => {
        taskStats.set(task.name, {
            lastRun: null,
            successCount: 0,
            failureCount: 0,
            consecutiveFailures: 0
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
