import {
    Client,
    EmbedBuilder,
    TextChannel,
    Message,
} from 'discord.js';
import { getQuotaLeaderboard, updateQuotaRoleConfig, getJSON, BackendError } from '../utilities/http.js';
import { OperationContext } from '../utilities/operation-context.js';
import { getRoleMembersWithCache } from '../utilities/member-fetching.js';
import { createLogger } from '../logging/logger.js';
import { formatPoints } from '../utilities/format-helpers.js';

const logger = createLogger('QuotaPanel');

/**
 * Update or create a quota leaderboard panel for a specific role
 * @param client Discord client
 * @param guildId Guild ID
 * @param roleId Role ID
 * @param config Quota configuration
 * @param ctx Operation context for caching API calls (optional, creates new if not provided)
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
    },
    ctx?: OperationContext
): Promise<void> {
    // Create context if not provided (for backwards compatibility)
    const opCtx = ctx || new OperationContext();
    
    try {
        // Get quota channel (use cached if available)
        const channels = await opCtx.getGuildChannels(guildId);
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

        // Fetch role members using smart caching strategy
        const { memberIds, fetchResult } = await getRoleMembersWithCache(role);
        
        logger.info('Collected role members for leaderboard', { 
            guildId, 
            roleId, 
            roleName: role.name, 
            memberCount: memberIds.length,
            fetchSource: fetchResult.source,
            fetchSuccess: fetchResult.success
        });
        
        // Get leaderboard data
        const result = await getQuotaLeaderboard(guildId, roleId, memberIds);
        logger.debug('Received leaderboard data', { guildId, roleId, entryCount: result.leaderboard.length });
        
        // Get quota config for base points and dungeon overrides (use cached if available)
        let configResult;
        try {
            configResult = await opCtx.getQuotaRoleConfig(guildId, roleId);
        } catch (err) {
            // Handle 404 gracefully - role may not have detailed config yet
            if (err instanceof BackendError && err.status === 404) {
                logger.debug('No detailed quota config found for role (using defaults)', { guildId, roleId });
                configResult = { config: null, dungeon_overrides: {} };
            } else {
                // Re-throw unexpected errors
                throw err;
            }
        }
        
        // If config is null, use defaults
        const quotaConfig = configResult.config || {
            base_exalt_points: 1,
            base_non_exalt_points: 1,
            moderation_points: 0,
            verify_points: 0,
            warn_points: 0,
            suspend_points: 0,
            modmail_reply_points: 0,
            editname_points: 0,
            addnote_points: 0,
        };
        
        // Build embed with config data
        const embed = buildLeaderboardEmbed(
            role.name,
            result.config.required_points,
            result.period_start,
            result.period_end,
            result.leaderboard,
            guild,
            quotaConfig,
            configResult.dungeon_overrides
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
    guild: any,
    config: {
        base_exalt_points: number;
        base_non_exalt_points: number;
        moderation_points: number;
        verify_points?: number;
        warn_points?: number;
        suspend_points?: number;
        modmail_reply_points?: number;
        editname_points?: number;
        addnote_points?: number;
    },
    dungeonOverrides: Record<string, number>
): EmbedBuilder {
    const periodEndDate = new Date(periodEnd);
    const periodStartDate = new Date(periodStart);
    const startTimestamp = Math.floor(periodStartDate.getTime() / 1000);
    const endTimestamp = Math.floor(periodEndDate.getTime() / 1000);

    // Build point sources section
    const pointSources: string[] = [];
    
    // Add base points if they're not 0
    if (config.base_exalt_points > 0) {
        pointSources.push(`**Exalt Dungeons:** ${formatPoints(config.base_exalt_points)} pts/run`);
    }
    if (config.base_non_exalt_points > 0) {
        pointSources.push(`**Non-Exalt Dungeons:** ${formatPoints(config.base_non_exalt_points)} pts/run`);
    }
    
    // Add moderation command points (individual commands)
    if (config.verify_points && config.verify_points > 0) {
        pointSources.push(`**Verifications:** ${formatPoints(config.verify_points)} pts each`);
    }
    if (config.warn_points && config.warn_points > 0) {
        pointSources.push(`**Warnings:** ${formatPoints(config.warn_points)} pts each`);
    }
    if (config.suspend_points && config.suspend_points > 0) {
        pointSources.push(`**Suspensions:** ${formatPoints(config.suspend_points)} pts each`);
    }
    if (config.modmail_reply_points && config.modmail_reply_points > 0) {
        pointSources.push(`**Modmail Replies:** ${formatPoints(config.modmail_reply_points)} pts each`);
    }
    if (config.editname_points && config.editname_points > 0) {
        pointSources.push(`**Name Edits:** ${formatPoints(config.editname_points)} pts each`);
    }
    if (config.addnote_points && config.addnote_points > 0) {
        pointSources.push(`**Notes Added:** ${formatPoints(config.addnote_points)} pts each`);
    }
    
    // Fallback: show old moderation_points if new fields aren't set (backward compatibility)
    if (config.moderation_points > 0 && (!config.verify_points || config.verify_points === 0)) {
        pointSources.push(`**Verifications:** ${formatPoints(config.moderation_points)} pts each`);
    }
    
    // Add dungeon overrides (sorted by points descending)
    const overridesList = Object.entries(dungeonOverrides)
        .filter(([, pts]) => pts > 0)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 10) // Show top 10 overrides
        .map(([dungeon, pts]) => `${dungeon}: ${formatPoints(pts)} pts`);
    
    if (overridesList.length > 0) {
        pointSources.push(`**Dungeon Overrides:** ${overridesList.join(', ')}`);
        if (Object.keys(dungeonOverrides).length > 10) {
            pointSources.push(`_...and ${Object.keys(dungeonOverrides).length - 10} more_`);
        }
    }

    const embed = new EmbedBuilder()
        .setTitle(`📊 ${roleName} Quota Leaderboard`)
        .setDescription(
            `**Required Points:** ${formatPoints(requiredPoints)}\n` +
            `**Start:** <t:${startTimestamp}:f>\n` +
            `**End:** <t:${endTimestamp}:f> (<t:${endTimestamp}:R>)` +
            (pointSources.length > 0 ? `\n\n__**Point Sources:**__\n${pointSources.join('\n')}` : '')
        )
        .setColor(0x5865F2)
        .setTimestamp();

    // Filter to only show members with more than 0 points
    const activeMembers = leaderboard.filter(entry => entry.points > 0);

    if (activeMembers.length === 0) {
        embed.addFields({
            name: 'No Activity',
            value: 'No one has earned points this period yet.',
            inline: false,
        });
    } else {
        // Build leaderboard text
        const leaderboardText = activeMembers
            .slice(0, 25) // Top 25
            .map((entry, index) => {
                const position = index + 1;
                const emoji = position === 1 ? '🥇' : position === 2 ? '🥈' : position === 3 ? '🥉' : `${position}.`;
                const metQuota = entry.points >= requiredPoints ? '✅' : '';
                return `${emoji} <@${entry.user_id}> - **${formatPoints(entry.points)}** pts ${metQuota}`;
            })
            .join('\n');

        embed.addFields({
            name: `Top ${Math.min(activeMembers.length, 25)} Members`,
            value: leaderboardText,
            inline: false,
        });

        // Show stats
        const metQuota = activeMembers.filter(e => e.points >= requiredPoints).length;
        const totalMembers = activeMembers.length;
        
        embed.setFooter({
            text: `${metQuota}/${totalMembers} members have met quota | Auto-updates periodically`,
        });
    }

    return embed;
}

/**
 * Update all quota panels for a guild
 * @param client Discord client
 * @param guildId Guild ID
 * @param ctx Operation context for caching API calls (optional, creates new if not provided)
 */
export async function updateAllQuotaPanels(client: Client, guildId: string, ctx?: OperationContext): Promise<void> {
    // Create context if not provided (for backwards compatibility)
    const opCtx = ctx || new OperationContext();
    
    try {
        // Fetch all quota configs for the guild (cached within this operation)
        const configs = await opCtx.getQuotaConfigs(guildId);

        // Update each panel
        for (const config of configs.configs) {
            if (config.panel_message_id) {
                await updateQuotaPanel(client, guildId, config.discord_role_id, config, opCtx);
            }
        }

        const stats = opCtx.getStats();
        logger.info('Updated all quota panels', { guildId, panelCount: configs.configs.length, cacheHits: stats });
    } catch (err) {
        logger.error('Failed to update all quota panels', { guildId, err });
    }
}

/**
 * Update quota panels for roles that a specific user has
 * @param client Discord client
 * @param guildId Guild ID
 * @param userId User ID
 * @param ctx Operation context for caching API calls (optional, creates new if not provided)
 */
export async function updateQuotaPanelsForUser(
    client: Client,
    guildId: string,
    userId: string,
    ctx?: OperationContext
): Promise<void> {
    // Create context if not provided (for backwards compatibility)
    const opCtx = ctx || new OperationContext();
    
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

        // Fetch all quota configs for the guild (cached within this operation)
        const configs = await opCtx.getQuotaConfigs(guildId);

        logger.debug('Found quota configs', { guildId, configCount: configs.configs.length });

        // Update panels for roles this user has
        let updatedCount = 0;
        for (const config of configs.configs) {
            if (member.roles.cache.has(config.discord_role_id)) {
                logger.debug('Updating panel for user role', { guildId, userId, roleId: config.discord_role_id });
                await updateQuotaPanel(client, guildId, config.discord_role_id, config, opCtx);
                updatedCount++;
            }
        }

        if (updatedCount > 0) {
            const stats = opCtx.getStats();
            logger.info('Updated quota panels for user', { guildId, userId, updatedCount, cacheHits: stats });
        } else {
            logger.debug('No panels updated for user', { guildId, userId });
        }
    } catch (err) {
        logger.error('Failed to update panels for user', { guildId, userId, err });
    }
}
