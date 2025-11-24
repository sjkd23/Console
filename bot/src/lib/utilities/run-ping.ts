import { Client, Guild, type GuildTextBasedChannel } from 'discord.js';
import { getJSON, postJSON, getDungeonRolePings } from './http.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('RunPing');

/**
 * Sends a ping message for a run, mentioning the run role and linking to the raid panel.
 * Automatically deletes the previous ping message if one exists.
 * 
 * @param client - Discord client
 * @param runId - Run ID
 * @param guild - Guild where the run is happening
 * @param messageType - Type of ping message: 'starting' (run going live) or 'ping' (manual ping)
 * @returns The new ping message ID, or null if failed
 */
export async function sendRunPing(
    client: Client,
    runId: number,
    guild: Guild,
    messageType: 'starting' | 'ping' = 'starting'
): Promise<string | null> {
    try {
        // Fetch run details
        const run = await getJSON<{
            channelId: string | null;
            postMessageId: string | null;
            dungeonLabel: string;
            dungeonKey: string;
            roleId: string | null;
            pingMessageId: string | null;
            status: string;
            party: string | null;
            location: string | null;
            chainAmount: number | null;
            keyPopCount: number;
        }>(`/runs/${runId}`, { guildId: guild.id });

        if (!run.channelId || !run.postMessageId) {
            logger.warn('Run missing channel or message ID', { runId });
            return null;
        }

        // Fetch the channel
        const channel = await client.channels.fetch(run.channelId).catch(() => null);
        if (!channel || !channel.isTextBased() || channel.isDMBased()) {
            logger.warn('Channel not found or invalid', { runId, channelId: run.channelId });
            return null;
        }

        const textChannel = channel as GuildTextBasedChannel;

        // Delete the previous ping message if it exists
        if (run.pingMessageId) {
            try {
                const oldPingMessage = await textChannel.messages.fetch(run.pingMessageId).catch(() => null);
                if (oldPingMessage && oldPingMessage.deletable) {
                    await oldPingMessage.delete();
                    logger.debug('Deleted previous ping message', { runId, oldPingMessageId: run.pingMessageId });
                }
            } catch (err) {
                logger.warn('Failed to delete previous ping message', { runId, pingMessageId: run.pingMessageId, error: err });
                // Continue anyway - this shouldn't block sending a new ping
            }
        }

        // Build the ping message based on run status
        let content = '';
        
        if (messageType === 'starting') {
            // Automatic ping when run goes live - include @here, dungeon role, and raid role
            content = '**Raid Starting!**';
        } else {
            // Manual ping by organizer - only ping raid role (not @here or dungeon role)
            if (run.status === 'open') {
                content = '🔔 **Raid Starting Soon!**';
            } else if (run.status === 'live') {
                content = '🔔 **Raid is Live!**';
            } else {
                content = '🔔 **Raid Update!**';
            }
        }
        
        // For automatic "starting" ping: add @here, dungeon role ping, and raid role
        // For manual ping: only add raid role (not @here or dungeon role)
        if (messageType === 'starting') {
            // Add @here for starting message
            content += ' @here';
            
            // Add dungeon-specific role ping if configured
            try {
                const { dungeon_role_pings } = await getDungeonRolePings(guild.id);
                const dungeonRoleId = dungeon_role_pings[run.dungeonKey];
                if (dungeonRoleId) {
                    content += ` <@&${dungeonRoleId}>`;
                }
            } catch (e) {
                logger.warn('Failed to fetch dungeon role pings', { 
                    guildId: guild.id, 
                    dungeonKey: run.dungeonKey,
                    error: e instanceof Error ? e.message : String(e)
                });
                // Continue without custom role ping
            }
        }
        
        // Always add run role mention if available
        if (run.roleId) {
            content += ` <@&${run.roleId}>`;
        }

        // Add link to the raid panel
        const raidPanelUrl = `https://discord.com/channels/${guild.id}/${run.channelId}/${run.postMessageId}`;
        content += `\n\n**${run.dungeonLabel}**`;
        
        // Add party/location info if available
        const info: string[] = [];
        if (run.party) info.push(`Party: **${run.party}**`);
        if (run.location) info.push(`Location: **${run.location}**`);
        if (run.dungeonKey !== 'ORYX_3' && run.chainAmount) {
            info.push(`Chain: **${run.keyPopCount}**/**${run.chainAmount}**`);
        }
        if (info.length > 0) {
            content += ` • ${info.join(' • ')}`;
        }
        
        content += `\n[Jump to Raid Panel](${raidPanelUrl})`;

        // Send the new ping message
        const pingMessage = await textChannel.send({ content });

        // Store the new ping message ID in the database
        await postJSON(`/runs/${runId}/ping-message`, { 
            pingMessageId: pingMessage.id 
        }, { guildId: guild.id });

        logger.info('Sent run ping message', { 
            runId, 
            pingMessageId: pingMessage.id,
            dungeonLabel: run.dungeonLabel 
        });

        return pingMessage.id;
    } catch (error) {
        logger.error('Failed to send run ping', { runId, error });
        return null;
    }
}

/**
 * Sends a key popped ping message for a run, mentioning the run role with expiration time.
 * Automatically deletes the previous ping message if one exists.
 * 
 * @param client - Discord client
 * @param runId - Run ID
 * @param guild - Guild where the run is happening
 * @param keyWindowEndsAt - ISO timestamp when the key window expires
 * @returns The new ping message ID, or null if failed
 */
export async function sendKeyPoppedPing(
    client: Client,
    runId: number,
    guild: Guild,
    keyWindowEndsAt: string
): Promise<string | null> {
    try {
        // Fetch run details
        const run = await getJSON<{
            channelId: string | null;
            postMessageId: string | null;
            dungeonLabel: string;
            dungeonKey: string;
            roleId: string | null;
            pingMessageId: string | null;
            party: string | null;
            location: string | null;
            chainAmount: number | null;
            keyPopCount: number;
        }>(`/runs/${runId}`, { guildId: guild.id });

        if (!run.channelId || !run.postMessageId) {
            logger.warn('Run missing channel or message ID', { runId });
            return null;
        }

        // Fetch the channel
        const channel = await client.channels.fetch(run.channelId).catch(() => null);
        if (!channel || !channel.isTextBased() || channel.isDMBased()) {
            logger.warn('Channel not found or invalid', { runId, channelId: run.channelId });
            return null;
        }

        const textChannel = channel as GuildTextBasedChannel;

        // Delete the previous ping message if it exists
        if (run.pingMessageId) {
            try {
                const oldPingMessage = await textChannel.messages.fetch(run.pingMessageId).catch(() => null);
                if (oldPingMessage && oldPingMessage.deletable) {
                    await oldPingMessage.delete();
                    logger.debug('Deleted previous ping message', { runId, oldPingMessageId: run.pingMessageId });
                }
            } catch (err) {
                logger.warn('Failed to delete previous ping message', { runId, pingMessageId: run.pingMessageId, error: err });
                // Continue anyway - this shouldn't block sending a new ping
            }
        }

        // Calculate expiration time
        const endsUnix = Math.floor(new Date(keyWindowEndsAt).getTime() / 1000);

        // Build the ping message
        let content = '🔑 **Key Popped!**';
        
        // Only ping raid role (not @here or dungeon role ping)
        if (run.roleId) {
            content += ` <@&${run.roleId}>`;
        }

        content += `\n\nPortal expires <t:${endsUnix}:R> • **${run.dungeonLabel}**`;
        
        // Add party/location info if available
        const info: string[] = [];
        if (run.party) info.push(`Party: **${run.party}**`);
        if (run.location) info.push(`Location: **${run.location}**`);
        if (run.dungeonKey !== 'ORYX_3' && run.keyPopCount > 0) {
            if (run.chainAmount && run.keyPopCount <= run.chainAmount) {
                info.push(`Chain: **${run.keyPopCount}**/**${run.chainAmount}**`);
            } else {
                info.push(`Chain: **${run.keyPopCount}**`);
            }
        }
        if (info.length > 0) {
            content += `\n${info.join(' • ')}`;
        }

        // Add link to the raid panel
        const raidPanelUrl = `https://discord.com/channels/${guild.id}/${run.channelId}/${run.postMessageId}`;
        content += `\n[Jump to Raid Panel](${raidPanelUrl})`;

        // Send the new ping message
        const pingMessage = await textChannel.send({ content });

        // Store the new ping message ID in the database
        await postJSON(`/runs/${runId}/ping-message`, { 
            pingMessageId: pingMessage.id 
        }, { guildId: guild.id });

        logger.info('Sent key popped ping message', { 
            runId, 
            pingMessageId: pingMessage.id,
            dungeonLabel: run.dungeonLabel,
            expiresAt: keyWindowEndsAt
        });

        return pingMessage.id;
    } catch (error) {
        logger.error('Failed to send key popped ping', { runId, error });
        return null;
    }
}

/**
 * Sends a realm score ping message for Oryx 3 runs, mentioning the run role.
 * NO TIMER - this is different from key popped pings.
 * Automatically deletes the previous ping message if one exists.
 * 
 * @param client - Discord client
 * @param runId - Run ID
 * @param guild - Guild where the run is happening
 * @param realmScore - Realm score percentage (1-99)
 * @returns The new ping message ID, or null if failed
 */
export async function sendRealmScorePing(
    client: Client,
    runId: number,
    guild: Guild,
    realmScore: number
): Promise<string | null> {
    try {
        // Fetch run details
        const run = await getJSON<{
            channelId: string | null;
            postMessageId: string | null;
            dungeonLabel: string;
            dungeonKey: string;
            roleId: string | null;
            pingMessageId: string | null;
            party: string | null;
            location: string | null;
        }>(`/runs/${runId}`, { guildId: guild.id });

        if (!run.channelId || !run.postMessageId) {
            logger.warn('Run missing channel or message ID', { runId });
            return null;
        }

        // Fetch the channel
        const channel = await client.channels.fetch(run.channelId).catch(() => null);
        if (!channel || !channel.isTextBased() || channel.isDMBased()) {
            logger.warn('Channel not found or invalid', { runId, channelId: run.channelId });
            return null;
        }

        const textChannel = channel as GuildTextBasedChannel;

        // Delete the previous ping message if it exists
        if (run.pingMessageId) {
            try {
                const oldPingMessage = await textChannel.messages.fetch(run.pingMessageId).catch(() => null);
                if (oldPingMessage && oldPingMessage.deletable) {
                    await oldPingMessage.delete();
                    logger.debug('Deleted previous ping message', { runId, oldPingMessageId: run.pingMessageId });
                }
            } catch (err) {
                logger.warn('Failed to delete previous ping message', { runId, pingMessageId: run.pingMessageId, error: err });
                // Continue anyway - this shouldn't block sending a new ping
            }
        }

        // Build the ping message (NO TIMER - that's the key difference!)
        let content = `**Realm Score: ${realmScore}%**`;
        
        // Only ping raid role (not @here or dungeon role ping)
        if (run.roleId) {
            content += ` <@&${run.roleId}>`;
        }

        content += `\n\n**${run.dungeonLabel}**`;
        
        // Add party/location info if available
        const info: string[] = [];
        if (run.party) info.push(`Party: **${run.party}**`);
        if (run.location) info.push(`Location: **${run.location}**`);
        if (info.length > 0) {
            content += ` • ${info.join(' • ')}`;
        }

        // Add link to the raid panel
        const raidPanelUrl = `https://discord.com/channels/${guild.id}/${run.channelId}/${run.postMessageId}`;
        content += `\n[Jump to Raid Panel](${raidPanelUrl})`;

        // Send the new ping message
        const pingMessage = await textChannel.send({ content });

        // Store the new ping message ID in the database
        await postJSON(`/runs/${runId}/ping-message`, { 
            pingMessageId: pingMessage.id 
        }, { guildId: guild.id });

        logger.info('Sent realm score ping message', { 
            runId, 
            pingMessageId: pingMessage.id,
            dungeonLabel: run.dungeonLabel,
            realmScore
        });

        return pingMessage.id;
    } catch (error) {
        logger.error('Failed to send realm score ping', { runId, error });
        return null;
    }
}
