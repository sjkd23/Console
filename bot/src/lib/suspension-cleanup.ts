// bot/src/lib/suspension-cleanup.ts
import { Client, EmbedBuilder, type TextChannel } from 'discord.js';
import { getJSON, postJSON } from './http.js';
import { createLogger } from './logger.js';

const logger = createLogger('SuspensionCleanup');

interface ExpiredSuspension {
    guild_id: string;
    user_id: string;
    id: string;
    moderator_id: string;
    reason: string;
    expires_at: string;
}

/**
 * Check all guilds for expired suspensions and remove the suspended role
 * This runs periodically to ensure users don't keep the role after expiration
 * 
 * Note: This function is wrapped in try/catch to ensure the scheduler never crashes.
 * Individual suspension processing failures are logged but don't stop the task.
 */
async function checkExpiredSuspensions(client: Client): Promise<void> {
    try {
        logger.debug('Starting expired suspensions check');
        
        // Get list of expired suspensions that still need role removal
        const response = await getJSON<{ expired: ExpiredSuspension[] }>('/punishments/expired');
        const { expired } = response;

        if (expired.length === 0) {
            logger.debug('No expired suspensions found');
            return; // Nothing to do
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
    } catch (err) {
        // Ensure this task never crashes the scheduler
        logger.error('Critical error in expired suspensions check', { err });
    }
}

/**
 * Start the automatic suspension cleanup task
 * Runs every 2 minutes to check for and process expired suspensions
 */
export function startSuspensionCleanup(client: Client): () => void {
    logger.info('Starting automatic suspension cleanup task');

    // Run immediately on startup
    checkExpiredSuspensions(client).catch(err => {
        logger.error('Initial expired suspensions check failed', { err });
    });

    // Then run every 2 minutes
    const intervalId = setInterval(() => {
        checkExpiredSuspensions(client).catch(err => {
            logger.error('Scheduled expired suspensions check failed', { err });
        });
    }, 2 * 60 * 1000); // 2 minutes

    // Return cleanup function
    return () => {
        logger.info('Stopping automatic suspension cleanup task');
        clearInterval(intervalId);
    };
}
