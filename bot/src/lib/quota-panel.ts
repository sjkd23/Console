import {
    Client,
    EmbedBuilder,
    TextChannel,
    Message,
} from 'discord.js';
import { getQuotaLeaderboard, getGuildChannels, updateQuotaRoleConfig, getJSON } from './http.js';
import { createLogger } from './logger.js';

const logger = createLogger('QuotaPanel');

/**
 * Update or create a quota leaderboard panel for a specific role
 */
export async function updateQuotaPanel(
    client: Client,
    guildId: string,
    roleId: string,
    config: {
        guild_id: string;
        discord_role_id: string;
        required_points: number;
        reset_at: string;
        panel_message_id: string | null;
    }
): Promise<void> {
    try {
        // Get quota channel
        const channels = await getGuildChannels(guildId);
        const quotaChannelId = channels.channels['quota'];
        
        if (!quotaChannelId) {
            logger.debug('No quota channel configured', { guildId });
            return;
        }

        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            logger.warn('Guild not found in cache', { guildId });
            return;
        }

        const quotaChannel = await guild.channels.fetch(quotaChannelId);
        if (!quotaChannel || !quotaChannel.isTextBased()) {
            logger.warn('Quota channel not found or not text-based', { guildId, quotaChannelId });
            return;
        }

        // Get role and its members
        const role = guild.roles.cache.get(roleId);
        if (!role) {
            logger.warn('Role not found in guild', { guildId, roleId });
            return;
        }

        // Fetch members with this specific role (more efficient than fetching all guild members)
        // If the role members aren't cached, fetch all members as a fallback
        let memberIds: string[];
        if (role.members.size > 0) {
            // Role members are already cached
            memberIds = role.members.map(m => m.id);
        } else {
            // Need to fetch members to populate the role.members cache
            logger.debug('Fetching all guild members to populate role cache', { guildId, roleId });
            await guild.members.fetch();
            memberIds = role.members.map(m => m.id);
        }
        
        logger.debug('Fetching leaderboard', { guildId, roleId, memberCount: memberIds.length });
        
        // Get leaderboard data
        const result = await getQuotaLeaderboard(guildId, roleId, memberIds);
        logger.debug('Received leaderboard data', { guildId, roleId, entryCount: result.leaderboard.length });
        
        // Build embed
        const embed = buildLeaderboardEmbed(
            role.name,
            result.config.required_points,
            result.period_start,
            result.period_end,
            result.leaderboard,
            guild
        );

        // Update or create message
        let message: Message | null = null;
        
        if (config.panel_message_id) {
            logger.debug('Attempting to update existing panel message', { guildId, roleId, messageId: config.panel_message_id });
        } else {
            logger.debug('No panel_message_id, will create new panel', { guildId, roleId });
        }
        
        if (config.panel_message_id) {
            try {
                message = await (quotaChannel as TextChannel).messages.fetch(config.panel_message_id);
                await message.edit({ embeds: [embed] });
                logger.info('Updated quota panel', { guildId, roleId, roleName: role.name });
            } catch (err) {
                logger.warn('Failed to fetch panel message, creating new one', { 
                    guildId, 
                    roleId, 
                    messageId: config.panel_message_id,
                    error: err instanceof Error ? err.message : String(err)
                });
                message = null;
            }
        }

        if (!message) {
            // Create new panel
            message = await (quotaChannel as TextChannel).send({ embeds: [embed] });
            
            // Update config with new message ID
            await updateQuotaRoleConfig(guildId, roleId, {
                actor_user_id: client.user!.id,
                actor_has_admin_permission: true,
                panel_message_id: message.id,
            });
            
            logger.info('Created new quota panel', { guildId, roleId, roleName: role.name, messageId: message.id });
        }

    } catch (err) {
        logger.error('Failed to update quota panel', { guildId, roleId, err });
    }
}

/**
 * Build the leaderboard embed
 */
function buildLeaderboardEmbed(
    roleName: string,
    requiredPoints: number,
    periodStart: string,
    periodEnd: string,
    leaderboard: Array<{ user_id: string; points: number; runs: number }>,
    guild: any
): EmbedBuilder {
    const periodEndDate = new Date(periodEnd);
    const periodStartDate = new Date(periodStart);
    const startTimestamp = Math.floor(periodStartDate.getTime() / 1000);
    const endTimestamp = Math.floor(periodEndDate.getTime() / 1000);

    const embed = new EmbedBuilder()
        .setTitle(`📊 ${roleName} Quota Leaderboard`)
        .setDescription(
            `**Required Points:** ${requiredPoints}\n` +
            `**Start:** <t:${startTimestamp}:f>\n` +
            `**End:** <t:${endTimestamp}:f> (<t:${endTimestamp}:R>)`
        )
        .setColor(0x5865F2)
        .setTimestamp();

    if (leaderboard.length === 0) {
        embed.addFields({
            name: 'No Activity',
            value: 'No one has earned points this period yet.',
            inline: false,
        });
    } else {
        // Build leaderboard text
        const leaderboardText = leaderboard
            .slice(0, 25) // Top 25
            .map((entry, index) => {
                const position = index + 1;
                const emoji = position === 1 ? '🥇' : position === 2 ? '🥈' : position === 3 ? '🥉' : `${position}.`;
                const metQuota = entry.points >= requiredPoints ? '✅' : '';
                return `${emoji} <@${entry.user_id}> - **${entry.points}** pts (${entry.runs} runs) ${metQuota}`;
            })
            .join('\n');

        embed.addFields({
            name: `Top ${Math.min(leaderboard.length, 25)} Members`,
            value: leaderboardText,
            inline: false,
        });

        // Show stats
        const metQuota = leaderboard.filter(e => e.points >= requiredPoints).length;
        const totalMembers = leaderboard.length;
        
        embed.setFooter({
            text: `${metQuota}/${totalMembers} members have met quota | Auto-updates periodically`,
        });
    }

    return embed;
}

/**
 * Update all quota panels for a guild
 */
export async function updateAllQuotaPanels(client: Client, guildId: string): Promise<void> {
    try {
        // Fetch all quota configs for the guild
        const configs = await getJSON<{
            configs: Array<{
                guild_id: string;
                discord_role_id: string;
                required_points: number;
                reset_at: string;
                panel_message_id: string | null;
            }>;
        }>(`/quota/configs/${guildId}`);

        // Update each panel
        for (const config of configs.configs) {
            if (config.panel_message_id) {
                await updateQuotaPanel(client, guildId, config.discord_role_id, config);
            }
        }

        logger.info('Updated all quota panels', { guildId, panelCount: configs.configs.length });
    } catch (err) {
        logger.error('Failed to update all quota panels', { guildId, err });
    }
}

/**
 * Update quota panels for roles that a specific user has
 */
export async function updateQuotaPanelsForUser(
    client: Client,
    guildId: string,
    userId: string
): Promise<void> {
    try {
        logger.debug('Starting panel update for user', { guildId, userId });
        
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            logger.warn('Guild not found in cache', { guildId });
            return;
        }

        const member = await guild.members.fetch(userId);
        if (!member) {
            logger.warn('Member not found in guild', { guildId, userId });
            return;
        }

        // Fetch all quota configs for the guild
        const configs = await getJSON<{
            configs: Array<{
                guild_id: string;
                discord_role_id: string;
                required_points: number;
                reset_at: string;
                panel_message_id: string | null;
            }>;
        }>(`/quota/configs/${guildId}`);

        logger.debug('Found quota configs', { guildId, configCount: configs.configs.length });

        // Update panels for roles this user has
        let updatedCount = 0;
        for (const config of configs.configs) {
            if (member.roles.cache.has(config.discord_role_id)) {
                logger.debug('Updating panel for user role', { guildId, userId, roleId: config.discord_role_id });
                await updateQuotaPanel(client, guildId, config.discord_role_id, config);
                updatedCount++;
            }
        }

        if (updatedCount > 0) {
            logger.info('Updated quota panels for user', { guildId, userId, updatedCount });
        } else {
            logger.debug('No panels updated for user', { guildId, userId });
        }
    } catch (err) {
        logger.error('Failed to update panels for user', { guildId, userId, err });
    }
}
