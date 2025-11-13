// bot/src/lib/run-auto-end.ts
import { Client, type GuildTextBasedChannel, EmbedBuilder } from 'discord.js';
import { getJSON, patchJSON } from './http.js';
import { createLogger } from './logger.js';

const logger = createLogger('RunAutoEnd');

interface ExpiredRun {
    id: number;
    guild_id: string;
    channel_id: string | null;
    post_message_id: string | null;
    dungeon_label: string;
    organizer_id: string;
    created_at: string;
    auto_end_minutes: number;
}

/**
 * Check all active runs and automatically end those that have exceeded their auto_end_minutes duration
 * This runs periodically to ensure runs don't stay open indefinitely
 * 
 * Note: This function is wrapped in try/catch to ensure the scheduler never crashes.
 * Individual run processing failures are logged but don't stop the task.
 */
async function checkExpiredRuns(client: Client): Promise<void> {
    try {
        logger.debug('Starting expired runs check');
        
        // Get list of runs that should be auto-ended
        const response = await getJSON<{ expired: ExpiredRun[] }>('/runs/expired');
        const { expired } = response;

        if (expired.length === 0) {
            logger.debug('No expired runs found');
            return; // Nothing to do
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
    } catch (err) {
        // Ensure this task never crashes the scheduler
        logger.error('Critical error in expired runs check', { err });
    }
}

/**
 * Start the automatic run auto-end task
 * Runs every 5 minutes to check for and process expired runs
 */
export function startRunAutoEnd(client: Client): () => void {
    logger.info('Starting automatic run auto-end task');

    // Run immediately on startup
    checkExpiredRuns(client).catch(err => {
        logger.error('Initial expired runs check failed', { err });
    });

    // Then run every 5 minutes
    const intervalId = setInterval(() => {
        checkExpiredRuns(client).catch(err => {
            logger.error('Scheduled expired runs check failed', { err });
        });
    }, 5 * 60 * 1000); // 5 minutes

    // Return cleanup function
    return () => {
        logger.info('Stopping automatic run auto-end task');
        clearInterval(intervalId);
    };
}
