import {
    ButtonInteraction,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    ButtonBuilder,
    EmbedBuilder,
    MessageFlags,
    PermissionFlagsBits,
    ModalSubmitInteraction,
    StringSelectMenuBuilder,
    StringSelectMenuInteraction,
    ComponentType,
} from 'discord.js';
import { getQuotaRoleConfig, updateQuotaRoleConfig, setDungeonOverride, deleteDungeonOverride, deleteQuotaRoleConfig, getGuildChannels, BackendError, recalculateQuotaPoints, manuallyResetQuotaPeriod } from '../../../lib/utilities/http.js';
import { DUNGEON_DATA } from '../../../constants/dungeons/DungeonData.js';
import { updateQuotaPanel } from '../../../lib/ui/quota-panel.js';
import { formatPoints, formatPointAmount } from '../../../lib/utilities/format-helpers.js';
import { buildQuotaBasePointsModal, QuotaBasePointsSchema } from '../../../lib/ui/quota-base-points.js';
import { buildQuotaConfigPanel } from '../../../lib/ui/quota-config-panel.js';
import { createLogger } from '../../../lib/logging/logger.js';
import { getRoleMembersWithCache } from '../../../lib/utilities/member-fetching.js';
import { deliverQuotaPeriodLog } from '../../../lib/ui/quota-log.js';

const logger = createLogger('QuotaConfig');

/**
 * Config panels expire after 10 minutes to prevent stale interactions
 */
const CONFIG_PANEL_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Helper function to check if a config panel has expired.
 * Config panels include a creation timestamp in their customId.
 * 
 * @param customId - The button customId (format: "prefix:roleId:timestamp:userId?")
 * @returns Object with `expired` boolean, `createdAt` timestamp, and `secondsAgo`
 */
function checkPanelExpiry(customId: string): { expired: boolean; createdAt: number; secondsAgo: number } {
    const parts = customId.split(':');
    // Format: "quota_config_basic:roleId:timestamp:userId?" or "quota_config_basic:roleId:timestamp"
    const createdAt = parseInt(parts[2], 10);
    
    if (isNaN(createdAt)) {
        // Old format without timestamp - treat as expired
        logger.warn('Config panel customId missing timestamp - treating as expired', { customId });
        return { expired: true, createdAt: 0, secondsAgo: Infinity };
    }
    
    const now = Date.now();
    const age = now - createdAt;
    const expired = age > CONFIG_PANEL_EXPIRY_MS;
    
    return { 
        expired, 
        createdAt, 
        secondsAgo: Math.floor(age / 1000) 
    };
}

/**
 * Handle expired panel interaction: silently ignore and remove buttons if they're still present.
 * 
 * @param interaction - The button interaction
 * @param expiryCheck - Result from checkPanelExpiry
 */
async function handleExpiredPanel(interaction: ButtonInteraction, expiryCheck: ReturnType<typeof checkPanelExpiry>): Promise<void> {
    logger.info('Config panel expired - removing buttons', {
        guildId: interaction.guildId,
        userId: interaction.user.id,
        customId: interaction.customId,
        secondsAgo: expiryCheck.secondsAgo
    });

    // Remove all buttons on the message (if not already removed)
    try {
        if (interaction.message.components.length > 0) {
            await interaction.update({
                components: []
            });

            logger.debug('Removed buttons from expired config panel', {
                guildId: interaction.guildId,
                messageId: interaction.message.id
            });
        } else {
            // Buttons already removed by timer, just acknowledge the interaction
            await interaction.deferUpdate();
        }
    } catch (err) {
        logger.warn('Failed to remove buttons from expired panel', {
            guildId: interaction.guildId,
            messageId: interaction.message.id,
            error: err instanceof Error ? err.message : String(err)
        });
        // Fallback: try to defer update to avoid "interaction failed"
        try {
            await interaction.deferUpdate();
        } catch { }
    }
}

/**
 * Helper function to build the dungeon selection dropdown panel
 */
async function buildDungeonSelectorPanel(guildId: string, roleId: string): Promise<{
    embed: EmbedBuilder;
    rows: ActionRowBuilder<StringSelectMenuBuilder>[];
}> {
    // Fetch current overrides
    let dungeonOverrides: Record<string, number> = {};
    let baseExaltPoints = 1;
    let baseNonExaltPoints = 0;
    try {
        const result = await getQuotaRoleConfig(guildId, roleId);
        dungeonOverrides = result.dungeon_overrides;
        baseExaltPoints = result.config?.base_exalt_points ?? 1;
        baseNonExaltPoints = result.config?.base_non_exalt_points ?? 0;
    } catch { }

    // Split dungeons into categories
    const exaltDungeons = DUNGEON_DATA.filter(d => d.dungeonCategory === 'Exaltation Dungeons');
    const otherDungeons = DUNGEON_DATA.filter(d => d.dungeonCategory !== 'Exaltation Dungeons');

    // Split other dungeons into two groups (25 each max)
    const misc1Dungeons = otherDungeons.slice(0, 25);
    const misc2Dungeons = otherDungeons.slice(25, 50);

    const createOptions = (dungeons: typeof DUNGEON_DATA) =>
        Array.from(dungeons).map(dungeon => {
            const override = dungeonOverrides[dungeon.codeName];
            return {
                label: dungeon.dungeonName,
                value: dungeon.codeName,
                description: override !== undefined ? `Current: ${formatPointAmount(override)}`
                    : `Base: ${formatPointAmount(dungeon.dungeonCategory === 'Exaltation Dungeons' ? baseExaltPoints : baseNonExaltPoints)}`,
                emoji: override !== undefined ? '⭐' : undefined,
            };
        });

    const rows: ActionRowBuilder<StringSelectMenuBuilder>[] = [];

    // Exaltation dungeons dropdown
    if (exaltDungeons.length > 0) {
        const exaltMenu = new StringSelectMenuBuilder()
            .setCustomId(`quota_select_dungeon_exalt:${roleId}`)
            .setPlaceholder('Exaltation Dungeons...')
            .addOptions(createOptions(exaltDungeons));
        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(exaltMenu));
    }

    // Misc 1 dungeons dropdown
    if (misc1Dungeons.length > 0) {
        const misc1Menu = new StringSelectMenuBuilder()
            .setCustomId(`quota_select_dungeon_misc1:${roleId}`)
            .setPlaceholder('Other Dungeons (Part 1)...')
            .addOptions(createOptions(misc1Dungeons));
        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(misc1Menu));
    }

    // Misc 2 dungeons dropdown (if needed)
    if (misc2Dungeons.length > 0) {
        const misc2Menu = new StringSelectMenuBuilder()
            .setCustomId(`quota_select_dungeon_misc2:${roleId}`)
            .setPlaceholder('Other Dungeons (Part 2)...')
            .addOptions(createOptions(misc2Dungeons));
        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(misc2Menu));
    }

    const configuredCount = Object.values(dungeonOverrides).filter(p => p !== undefined && p !== 1).length;

    const embed = new EmbedBuilder()
        .setTitle('🗺️ Configure Dungeon Points')
        .setDescription(
            'Select a dungeon to set custom point values. By default, all dungeons are worth 1 point.\n\n' +
            `⭐ = Custom override set (${configuredCount} dungeon${configuredCount === 1 ? '' : 's'})\n\n` +
            `**Categories:**\n` +
            `• Exaltation Dungeons (${exaltDungeons.length})\n` +
            `• Other Dungeons Part 1 (${misc1Dungeons.length})\n` +
            `• Other Dungeons Part 2 (${misc2Dungeons.length})`
        )
        .setColor(0x5865F2);

    return { embed, rows };
}

/**
 * Handle quota_config_basic button
 * Opens a modal to set settings for future quota periods.
 */
export async function handleQuotaConfigBasic(interaction: ButtonInteraction) {
    // Check panel expiry first
    const expiryCheck = checkPanelExpiry(interaction.customId);
    if (expiryCheck.expired) {
        await handleExpiredPanel(interaction, expiryCheck);
        return;
    }

    const customIdParts = interaction.customId.split(':');
    const roleId = customIdParts[1];
    // customIdParts[2] is the timestamp
    const authorizedUserId = customIdParts.length > 3 ? customIdParts[3] : null;

    if (!roleId) {
        await interaction.reply({ content: '❌ Invalid interaction data', flags: MessageFlags.Ephemeral });
        return;
    }

    // Check if only the command user can interact (only if user ID is specified)
    if (authorizedUserId && interaction.user.id !== authorizedUserId) {
        await interaction.reply({ 
            content: '❌ Only the user who ran the command can use these buttons.', 
            flags: MessageFlags.Ephemeral 
        });
        return;
    }

    // Check permissions (required even if no specific user restriction)
    const member = await interaction.guild?.members.fetch(interaction.user.id);
    if (!member?.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: '❌ Administrator permission required', flags: MessageFlags.Ephemeral });
        return;
    }

    // Fetch current config to pre-fill
    let config: Awaited<ReturnType<typeof getQuotaRoleConfig>>['config'] = null;
    try {
        const result = await getQuotaRoleConfig(interaction.guildId!, roleId);
        config = result.config;
    } catch { }

    const modal = new ModalBuilder()
        .setCustomId(`quota_basic_modal:${roleId}:${interaction.message.id}`)
        .setTitle('Configure Basic Quota Settings');

    const requiredPointsInput = new TextInputBuilder()
        .setCustomId('required_points')
        .setLabel('Required Points Per Period')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g., 10 or 12.55')
        .setRequired(true)
        .setValue(config?.required_points?.toFixed(2) || '0.00');

    const resetIntervalInput = new TextInputBuilder()
        .setCustomId('reset_interval_days')
        .setLabel('Reset Interval (days, 1-365)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g., 7')
        .setRequired(true)
        .setValue(String(config?.reset_interval_days ?? 7));

    modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(requiredPointsInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(resetIntervalInput)
    );

    await interaction.showModal(modal);
}

/**
 * Handle quota_basic_modal submission
 */
export async function handleQuotaBasicModal(interaction: ModalSubmitInteraction) {
    const parts = interaction.customId.split(':');
    const roleId = parts[1];
    const mainPanelMessageId = parts[2];
    
    if (!roleId) {
        await interaction.reply({ content: '❌ Invalid interaction data', flags: MessageFlags.Ephemeral });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Parse inputs
    const requiredPoints = parseFloat(interaction.fields.getTextInputValue('required_points'));
    const resetIntervalDays = Number(interaction.fields.getTextInputValue('reset_interval_days').trim());

    // Validate required points (allow decimals up to 2 decimal places)
    if (isNaN(requiredPoints) || requiredPoints < 0) {
        await interaction.editReply('❌ Required points must be a non-negative number.');
        return;
    }

    // Check decimal places (max 2)
    if (Math.round(requiredPoints * 100) !== requiredPoints * 100) {
        await interaction.editReply('❌ Required points can have at most 2 decimal places (e.g., 12.55).');
        return;
    }

    if (!Number.isInteger(resetIntervalDays) || resetIntervalDays < 1 || resetIntervalDays > 365) {
        await interaction.editReply('❌ Reset interval must be a whole number from 1 to 365 days.');
        return;
    }

    // Check permissions
    const member = await interaction.guild?.members.fetch(interaction.user.id);
    const hasAdminPerm = member?.permissions.has(PermissionFlagsBits.Administrator);

    try {
        const quotaRole = interaction.guild?.roles.cache.get(roleId);
        const memberUserIds = quotaRole
            ? (await getRoleMembersWithCache(quotaRole)).memberIds
            : undefined;
        await updateQuotaRoleConfig(interaction.guildId!, roleId, {
            actor_user_id: interaction.user.id,
            actor_has_admin_permission: hasAdminPerm,
            required_points: requiredPoints,
            reset_interval_days: resetIntervalDays,
            member_user_ids: requiredPoints <= 0 ? memberUserIds : undefined,
        });

        await interaction.editReply(requiredPoints <= 0
            ? '✅ Quota automation is now inactive. Any active partial period was finalized without a successor.'
            : `✅ **Quota configuration updated!**\n\n` +
              `**Next Required Points:** ${formatPoints(requiredPoints)}\n` +
              `**Next Reset Interval:** ${resetIntervalDays} day${resetIntervalDays === 1 ? '' : 's'}\n\n` +
              `These changes apply to the next period; a newly activated quota starts now.`
        );

        // Refresh the original /configquota panel using webhook
        if (mainPanelMessageId) {
            try {
                const { embed: mainEmbed, buttons: mainButtons } = await buildQuotaConfigPanel(interaction.guildId!, roleId);
                
                await interaction.webhook.editMessage(mainPanelMessageId, {
                    embeds: [mainEmbed],
                    components: mainButtons,
                });
            } catch (err) {
                console.error('Failed to refresh main quota config panel:', err);
                // Non-critical, continue
            }
        }
    } catch (err) {
        console.error('Failed to update quota config:', err);
        const msg = err instanceof BackendError ? err.message : 'Unknown error';
        await interaction.editReply(`❌ Failed to update configuration: ${msg}`);
    }
}

/** Toggle rollover for future periods without asking administrators to type a boolean. */
export async function handleQuotaToggleRollover(interaction: ButtonInteraction): Promise<void> {
    const expiryCheck = checkPanelExpiry(interaction.customId);
    if (expiryCheck.expired) {
        await handleExpiredPanel(interaction, expiryCheck);
        return;
    }

    const parts = interaction.customId.split(':');
    const roleId = parts[1];
    const authorizedUserId = parts[3];
    if (!roleId) {
        await interaction.reply({ content: '❌ Invalid interaction data', flags: MessageFlags.Ephemeral });
        return;
    }
    if (authorizedUserId && interaction.user.id !== authorizedUserId) {
        await interaction.reply({ content: '❌ Only the user who ran the command can use these buttons.', flags: MessageFlags.Ephemeral });
        return;
    }

    const member = await interaction.guild?.members.fetch(interaction.user.id);
    if (!member?.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: '❌ Administrator permission required', flags: MessageFlags.Ephemeral });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
        const current = await getQuotaRoleConfig(interaction.guildId!, roleId);
        if (!current.config) {
            await interaction.editReply('❌ No quota configuration found for this role.');
            return;
        }
        const enabled = !current.config.rollover_enabled;
        await updateQuotaRoleConfig(interaction.guildId!, roleId, {
            actor_user_id: interaction.user.id,
            actor_has_admin_permission: true,
            rollover_enabled: enabled,
        });
        const { embed, buttons } = await buildQuotaConfigPanel(interaction.guildId!, roleId, authorizedUserId);
        await interaction.message.edit({ embeds: [embed], components: buttons });
        await interaction.editReply(
            `✅ Rollover is now **${enabled ? 'enabled' : 'disabled'}** for the next quota period. The active period is unchanged.`
        );
    } catch (err) {
        const message = err instanceof BackendError ? err.message : 'Unknown error';
        await interaction.editReply(`❌ Failed to update rollover: ${message}`);
    }
}

/**
 * Handle quota_config_moderation button
 * Opens a modal to set moderation points (verification points)
 */
export async function handleQuotaConfigModeration(interaction: ButtonInteraction) {
    // Check panel expiry first
    const expiryCheck = checkPanelExpiry(interaction.customId);
    if (expiryCheck.expired) {
        await handleExpiredPanel(interaction, expiryCheck);
        return;
    }

    const customIdParts = interaction.customId.split(':');
    const roleId = customIdParts[1];
    // customIdParts[2] is the timestamp
    const authorizedUserId = customIdParts.length > 3 ? customIdParts[3] : null;

    if (!roleId) {
        await interaction.reply({ content: '❌ Invalid interaction data', flags: MessageFlags.Ephemeral });
        return;
    }

    // Check if only the command user can interact (only if user ID is specified)
    if (authorizedUserId && interaction.user.id !== authorizedUserId) {
        await interaction.reply({ 
            content: '❌ Only the user who ran the command can use these buttons.', 
            flags: MessageFlags.Ephemeral 
        });
        return;
    }

    // Check permissions (required even if no specific user restriction)
    const member = await interaction.guild?.members.fetch(interaction.user.id);
    if (!member?.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: '❌ Administrator permission required', flags: MessageFlags.Ephemeral });
        return;
    }

    // Fetch current config to pre-fill
    let config: any = null;
    try {
        const result = await getQuotaRoleConfig(interaction.guildId!, roleId);
        config = result.config;
    } catch { }

    const modal = new ModalBuilder()
        .setCustomId(`quota_moderation_modal:${roleId}:${interaction.message.id}`)
        .setTitle('Configure Moderation Points');

    // Create individual inputs for each command
    const verifyPointsInput = new TextInputBuilder()
        .setCustomId('verify_points')
        .setLabel('Points Per Verification (/verify)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g., 2 or 0.5')
        .setRequired(true)
        .setValue(config?.verify_points?.toFixed(2) || '0.00');

    const warnPointsInput = new TextInputBuilder()
        .setCustomId('warn_points')
        .setLabel('Points Per Warning (/warn)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g., 1 or 0')
        .setRequired(true)
        .setValue(config?.warn_points?.toFixed(2) || '0.00');

    const suspendPointsInput = new TextInputBuilder()
        .setCustomId('suspend_points')
        .setLabel('Points Per Suspension (/suspend)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g., 1 or 0')
        .setRequired(true)
        .setValue(config?.suspend_points?.toFixed(2) || '0.00');

    const modmailReplyPointsInput = new TextInputBuilder()
        .setCustomId('modmail_reply_points')
        .setLabel('Points Per Modmail Reply')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g., 0.5 or 0')
        .setRequired(true)
        .setValue(config?.modmail_reply_points?.toFixed(2) || '0.00');

    const editnamePointsInput = new TextInputBuilder()
        .setCustomId('editname_points')
        .setLabel('Points Per Name Edit (/editname)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g., 0.25 or 0')
        .setRequired(true)
        .setValue(config?.editname_points?.toFixed(2) || '0.00');

    modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(verifyPointsInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(warnPointsInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(suspendPointsInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(modmailReplyPointsInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(editnamePointsInput)
    );

    await interaction.showModal(modal);
}

/**
 * Handle quota_moderation_modal submission
 */
export async function handleQuotaModerationModal(interaction: ModalSubmitInteraction) {
    const parts = interaction.customId.split(':');
    const roleId = parts[1];
    const mainPanelMessageId = parts[2];
    
    if (!roleId) {
        await interaction.reply({ content: '❌ Invalid interaction data', flags: MessageFlags.Ephemeral });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Parse all command-specific point inputs
    const verifyPoints = parseFloat(interaction.fields.getTextInputValue('verify_points'));
    const warnPoints = parseFloat(interaction.fields.getTextInputValue('warn_points'));
    const suspendPoints = parseFloat(interaction.fields.getTextInputValue('suspend_points'));
    const modmailReplyPoints = parseFloat(interaction.fields.getTextInputValue('modmail_reply_points'));
    const editnamePoints = parseFloat(interaction.fields.getTextInputValue('editname_points'));

    // Note: addnote_points is not in the modal due to 5 component limit, 
    // will need to be configured separately or we need a different approach
    // For now, we'll set it to 0 or preserve existing value

    // Validate all points (allow decimals up to 2 decimal places)
    const pointsToValidate = [
        { name: 'Verify', value: verifyPoints },
        { name: 'Warn', value: warnPoints },
        { name: 'Suspend', value: suspendPoints },
        { name: 'Modmail Reply', value: modmailReplyPoints },
        { name: 'Editname', value: editnamePoints },
    ];

    for (const { name, value } of pointsToValidate) {
        if (isNaN(value) || value < 0) {
            await interaction.editReply(`❌ ${name} points must be a non-negative number.`);
            return;
        }
        if (Math.round(value * 100) !== value * 100) {
            await interaction.editReply(`❌ ${name} points can have at most 2 decimal places (e.g., 1.25).`);
            return;
        }
    }

    // Check permissions
    const member = await interaction.guild?.members.fetch(interaction.user.id);
    const hasAdminPerm = member?.permissions.has(PermissionFlagsBits.Administrator);

    try {
        await updateQuotaRoleConfig(interaction.guildId!, roleId, {
            actor_user_id: interaction.user.id,
            actor_has_admin_permission: hasAdminPerm,
            verify_points: verifyPoints,
            warn_points: warnPoints,
            suspend_points: suspendPoints,
            modmail_reply_points: modmailReplyPoints,
            editname_points: editnamePoints,
        });

        // Build success message
        const commandPoints = [
            { name: 'Verification', points: verifyPoints, commands: '`/verify`, manual approvals' },
            { name: 'Warning', points: warnPoints, commands: '`/warn`' },
            { name: 'Suspension', points: suspendPoints, commands: '`/suspend`' },
            { name: 'Modmail Reply', points: modmailReplyPoints, commands: 'Replying to modmail' },
            { name: 'Name Edit', points: editnamePoints, commands: '`/editname`' },
        ];

        const enabledCommands = commandPoints.filter(c => c.points > 0);
        
        let message = `✅ **Moderation points updated!**\n\n`;
        
        if (enabledCommands.length > 0) {
            message += `**Enabled Commands:**\n`;
            enabledCommands.forEach(c => {
                message += `• ${c.name}: **${formatPoints(c.points)} point${c.points === 1 ? '' : 's'}** (${c.commands})\n`;
            });
        } else {
            message += `⚠️ All moderation commands are set to 0 points. Staff will not earn quota points for moderation actions.\n`;
        }

        message += `\n💡 **Note:** Use \`/addnote\` points must be configured separately (modal limit).`;

        await interaction.editReply(message);

        // Refresh the original /configquota panel using webhook
        if (mainPanelMessageId) {
            try {
                const { embed: mainEmbed, buttons: mainButtons } = await buildQuotaConfigPanel(interaction.guildId!, roleId);
                
                await interaction.webhook.editMessage(mainPanelMessageId, {
                    embeds: [mainEmbed],
                    components: mainButtons,
                });
            } catch (err) {
                console.error('Failed to refresh main quota config panel:', err);
                // Non-critical, continue
            }
        }

        // Refresh the quota leaderboard panel to show updated Point Sources
        try {
            const updatedResult = await getQuotaRoleConfig(interaction.guildId!, roleId);
            if (updatedResult.config) {
                await updateQuotaPanel(interaction.client, interaction.guildId!, roleId, updatedResult.config);
            }
        } catch (err) {
            console.error('Failed to refresh quota panel after moderation points update:', err);
            // Non-critical, continue
        }
    } catch (err) {
        console.error('Failed to update moderation points:', err);
        const msg = err instanceof BackendError ? err.message : 'Unknown error';
        await interaction.editReply(`❌ Failed to update configuration: ${msg}`);
    }
}

/**
 * Handle quota_config_base_points button
 * Opens a modal to set base exalt and non-exalt dungeon points
 */
export async function handleQuotaConfigBasePoints(interaction: ButtonInteraction) {
    // Check panel expiry first
    const expiryCheck = checkPanelExpiry(interaction.customId);
    if (expiryCheck.expired) {
        await handleExpiredPanel(interaction, expiryCheck);
        return;
    }

    const customIdParts = interaction.customId.split(':');
    const roleId = customIdParts[1];
    // customIdParts[2] is the timestamp
    const authorizedUserId = customIdParts.length > 3 ? customIdParts[3] : null;

    if (!roleId) {
        await interaction.reply({ content: '❌ Invalid interaction data', flags: MessageFlags.Ephemeral });
        return;
    }

    // Check if only the command user can interact (only if user ID is specified)
    if (authorizedUserId && interaction.user.id !== authorizedUserId) {
        await interaction.reply({ 
            content: '❌ Only the user who ran the command can use these buttons.', 
            flags: MessageFlags.Ephemeral 
        });
        return;
    }

    // Check permissions (required even if no specific user restriction)
    const member = await interaction.guild?.members.fetch(interaction.user.id);
    if (!member?.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: '❌ Administrator permission required', flags: MessageFlags.Ephemeral });
        return;
    }

    // Fetch failures must not turn an existing configuration into default values.
    const { config } = await getQuotaRoleConfig(interaction.guildId!, roleId);
    const modal = buildQuotaBasePointsModal(roleId, interaction.message.id, config);

    await interaction.showModal(modal);
}

/**
 * Handle quota_base_points_modal submission
 */
export async function handleQuotaBasePointsModal(interaction: ModalSubmitInteraction) {
    const parts = interaction.customId.split(':');
    const roleId = parts[1];
    const mainPanelMessageId = parts[2];
    
    if (!roleId) {
        await interaction.reply({ content: '❌ Invalid interaction data', flags: MessageFlags.Ephemeral });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const parsed = QuotaBasePointsSchema.safeParse({
        base_exalt_points: interaction.fields.getTextInputValue('base_exalt_points'),
        base_non_exalt_points: interaction.fields.getTextInputValue('base_non_exalt_points'),
        misc_points_per_minute: interaction.fields.getTextInputValue('misc_points_per_minute'),
    });
    if (!parsed.success) {
        await interaction.editReply('❌ Enter nonnegative points with at most two decimal places (maximum 99999999.99).');
        return;
    }
    const { base_exalt_points: baseExaltPoints, base_non_exalt_points: baseNonExaltPoints,
        misc_points_per_minute: miscPointsPerMinute } = parsed.data;

    // Check permissions
    const member = await interaction.guild?.members.fetch(interaction.user.id);
    const hasAdminPerm = member?.permissions.has(PermissionFlagsBits.Administrator);

    try {
        await updateQuotaRoleConfig(interaction.guildId!, roleId, {
            actor_user_id: interaction.user.id,
            actor_has_admin_permission: hasAdminPerm,
            base_exalt_points: baseExaltPoints,
            base_non_exalt_points: baseNonExaltPoints,
            misc_points_per_minute: miscPointsPerMinute,
        });

        await interaction.editReply(
            `✅ **Base dungeon points updated!**\n\n` +
            `**Exalt Dungeons:** ${formatPointAmount(baseExaltPoints)}\n` +
            `**Non-Exalt Dungeons:** ${formatPointAmount(baseNonExaltPoints)} per Dungeon Entered (additive)\n` +
            `**Non-Exalt Minute Rate:** ${formatPoints(miscPointsPerMinute)}/min\n\n` +
            `The shared minute rate applies to single non-exalt runs, Realm Clearing, and multi non-exalt runs. ` +
            `Dungeon overrides apply to individual dungeons; grouped runs and Realm Clearing use base points.`
        );

        // Refresh the original /configquota panel using webhook
        if (mainPanelMessageId) {
            try {
                const { embed: mainEmbed, buttons: mainButtons } = await buildQuotaConfigPanel(interaction.guildId!, roleId);
                
                await interaction.webhook.editMessage(mainPanelMessageId, {
                    embeds: [mainEmbed],
                    components: mainButtons,
                });
            } catch (err) {
                console.error('Failed to refresh main quota config panel:', err);
                // Non-critical, continue
            }
        }

        // Refresh the quota leaderboard panel to show updated Point Sources
        try {
            const updatedResult = await getQuotaRoleConfig(interaction.guildId!, roleId);
            if (updatedResult.config) {
                await updateQuotaPanel(interaction.client, interaction.guildId!, roleId, updatedResult.config);
            }
        } catch (err) {
            console.error('Failed to refresh quota panel after base points update:', err);
            // Non-critical, continue
        }
    } catch (err) {
        console.error('Failed to update base points:', err);
        const msg = err instanceof BackendError ? err.message : 'Unknown error';
        await interaction.editReply(`❌ Failed to update configuration: ${msg}`);
    }
}

/**
 * Handle quota_config_dungeons button
 * Shows select menus to choose a dungeon to configure
 * Split into Exaltation, Misc 1, and Misc 2 to handle Discord's 25-option limit
 */
export async function handleQuotaConfigDungeons(interaction: ButtonInteraction) {
    // Check panel expiry first
    const expiryCheck = checkPanelExpiry(interaction.customId);
    if (expiryCheck.expired) {
        await handleExpiredPanel(interaction, expiryCheck);
        return;
    }

    const customIdParts = interaction.customId.split(':');
    const roleId = customIdParts[1];
    // customIdParts[2] is the timestamp
    const authorizedUserId = customIdParts.length > 3 ? customIdParts[3] : null;

    if (!roleId) {
        await interaction.reply({ content: '❌ Invalid interaction data', flags: MessageFlags.Ephemeral });
        return;
    }

    // Check if only the command user can interact (only if user ID is specified)
    if (authorizedUserId && interaction.user.id !== authorizedUserId) {
        await interaction.reply({ 
            content: '❌ Only the user who ran the command can use these buttons.', 
            flags: MessageFlags.Ephemeral 
        });
        return;
    }

    // Check permissions (required even if no specific user restriction)
    const member = await interaction.guild?.members.fetch(interaction.user.id);
    if (!member?.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: '❌ Administrator permission required', flags: MessageFlags.Ephemeral });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const mainPanelMessageId = interaction.message.id;
    
    const { embed, rows } = await buildDungeonSelectorPanel(interaction.guildId!, roleId);

    // Send the dropdown panel and get the message
    const reply = await interaction.editReply({
        embeds: [embed],
        components: rows.slice(0, 5), // Discord max 5 action rows
    });

    // Update the select menus to include the main panel message ID
    const updatedRows = rows.slice(0, 5).map(row => {
        const menu = row.components[0] as StringSelectMenuBuilder;
        const currentId = menu.data.custom_id!;
        // Append dropdown message ID and main panel message ID to custom_id
        menu.setCustomId(`${currentId}:${reply.id}:${mainPanelMessageId}`);
        return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
    });

    await interaction.editReply({
        embeds: [embed],
        components: updatedRows,
    });
}

/**
 * Handle quota_select_dungeon select menu
 */
export async function handleQuotaSelectDungeon(interaction: StringSelectMenuInteraction) {
    const customIdParts = interaction.customId.split(':');
    const roleId = customIdParts[1];
    const dropdownMessageId = customIdParts[2];
    const mainPanelMessageId = customIdParts[3];
    const dungeonKey = interaction.values[0];

    if (!roleId || !dungeonKey) {
        await interaction.reply({ content: '❌ Invalid interaction data', flags: MessageFlags.Ephemeral });
        return;
    }

    // Check permissions
    const member = await interaction.guild?.members.fetch(interaction.user.id);
    if (!member?.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: '❌ Administrator permission required', flags: MessageFlags.Ephemeral });
        return;
    }

    // Find dungeon info
    const dungeon = DUNGEON_DATA.find(d => d.codeName === dungeonKey);
    if (!dungeon) {
        await interaction.reply({ content: '❌ Dungeon not found', flags: MessageFlags.Ephemeral });
        return;
    }

    // Fetch current override
    let currentOverride: number | undefined;
    try {
        const result = await getQuotaRoleConfig(interaction.guildId!, roleId);
        currentOverride = result.dungeon_overrides[dungeonKey];
    } catch { }

    // Encode both message IDs in the modal customId
    const modal = new ModalBuilder()
        .setCustomId(`quota_dungeon_modal:${roleId}:${dungeonKey}:${dropdownMessageId}:${mainPanelMessageId}`)
        .setTitle(`${dungeon.dungeonName} Points`);

    const pointsInput = new TextInputBuilder()
        .setCustomId('points')
        .setLabel(`Point Value (0 or negative to remove)`)
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g., 2.25, 0.5, or -1 to remove')
        .setRequired(true)
        .setValue(currentOverride !== undefined ? formatPoints(currentOverride) : '1');

    modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(pointsInput)
    );

    await interaction.showModal(modal);
}

/**
 * Handle quota_dungeon_modal submission
 */
export async function handleQuotaDungeonModal(interaction: ModalSubmitInteraction) {
    const parts = interaction.customId.split(':');
    const roleId = parts[1];
    const dungeonKey = parts[2];
    const dropdownMessageId = parts[3];
    const mainPanelMessageId = parts[4];

    if (!roleId || !dungeonKey) {
        await interaction.reply({ content: '❌ Invalid interaction data', flags: MessageFlags.Ephemeral });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const points = parseFloat(interaction.fields.getTextInputValue('points'));

    if (isNaN(points)) {
        await interaction.editReply('❌ Points must be a valid number. Use 0 or negative values to remove the override.');
        return;
    }

    // Check decimal places (max 2) for positive values only
    if (points >= 0 && Math.round(points * 100) !== points * 100) {
        await interaction.editReply('❌ Points can have at most 2 decimal places (e.g., 2.25 or 0.5).');
        return;
    }

    const member = await interaction.guild?.members.fetch(interaction.user.id);
    const hasAdminPerm = member?.permissions.has(PermissionFlagsBits.Administrator);

    try {
        if (points <= 0) {
            // Remove override (0 or negative)
            await deleteDungeonOverride(interaction.guildId!, roleId, dungeonKey, {
                actor_user_id: interaction.user.id,
                actor_has_admin_permission: hasAdminPerm,
            });
            await interaction.editReply(`✅ Removed custom point override for **${dungeonKey}** (reverted to default)`);
        } else {
            // Set override
            await setDungeonOverride(interaction.guildId!, roleId, dungeonKey, {
                actor_user_id: interaction.user.id,
                actor_has_admin_permission: hasAdminPerm,
                points,
            });
            await interaction.editReply(`✅ Set **${dungeonKey}** to **${formatPoints(points)} point${points === 1 ? '' : 's'}**`);
        }

        // Refresh the dropdown selector panel using webhook
        if (dropdownMessageId) {
            try {
                const { embed, rows } = await buildDungeonSelectorPanel(interaction.guildId!, roleId);
                
                // Update customIds to include message IDs
                const updatedRows = rows.slice(0, 5).map(row => {
                    const menu = row.components[0] as StringSelectMenuBuilder;
                    const currentId = menu.data.custom_id!;
                    // Append dropdown message ID and main panel message ID to custom_id
                    menu.setCustomId(`${currentId}:${dropdownMessageId}:${mainPanelMessageId}`);
                    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
                });

                await interaction.webhook.editMessage(dropdownMessageId, {
                    embeds: [embed],
                    components: updatedRows,
                });
            } catch (err) {
                console.error('Failed to refresh dropdown selector:', err);
                // Non-critical, continue
            }
        }

        // Refresh the original /configquota panel using webhook
        if (mainPanelMessageId) {
            try {
                const { embed: mainEmbed, buttons: mainButtons } = await buildQuotaConfigPanel(interaction.guildId!, roleId);
                
                await interaction.webhook.editMessage(mainPanelMessageId, {
                    embeds: [mainEmbed],
                    components: mainButtons,
                });
            } catch (err) {
                console.error('Failed to refresh main quota config panel:', err);
                // Non-critical, continue
            }
        }

        // Refresh the quota leaderboard panel to show updated Point Sources
        try {
            const updatedResult = await getQuotaRoleConfig(interaction.guildId!, roleId);
            if (updatedResult.config) {
                await updateQuotaPanel(interaction.client, interaction.guildId!, roleId, updatedResult.config);
            }
        } catch (err) {
            console.error('Failed to refresh quota panel after dungeon override update:', err);
            // Non-critical, continue
        }
    } catch (err) {
        console.error('Failed to update dungeon override:', err);
        const msg = err instanceof BackendError ? err.message : 'Unknown error';
        await interaction.editReply(`❌ Failed to update dungeon override: ${msg}`);
    }
}

/**
 * Handle quota_refresh_panel button
 * Recalculates quota points based on current configuration, then updates the panel.
 * This ensures the panel reflects current point values even if configuration changed.
 */
export async function handleQuotaRefreshPanel(interaction: ButtonInteraction) {
    // Check panel expiry first
    const expiryCheck = checkPanelExpiry(interaction.customId);
    if (expiryCheck.expired) {
        await handleExpiredPanel(interaction, expiryCheck);
        return;
    }

    const customIdParts = interaction.customId.split(':');
    const roleId = customIdParts[1];
    // customIdParts[2] is the timestamp
    const authorizedUserId = customIdParts.length > 3 ? customIdParts[3] : null;

    if (!roleId) {
        await interaction.reply({ content: '❌ Invalid interaction data', flags: MessageFlags.Ephemeral });
        return;
    }

    // Check if only the command user can interact (only if user ID is specified)
    if (authorizedUserId && interaction.user.id !== authorizedUserId) {
        await interaction.reply({ 
            content: '❌ Only the user who ran the command can use these buttons.', 
            flags: MessageFlags.Ephemeral 
        });
        return;
    }

    // Check permissions (required even if no specific user restriction)
    const member = await interaction.guild?.members.fetch(interaction.user.id);
    if (!member?.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: '❌ Administrator permission required', flags: MessageFlags.Ephemeral });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        // Fetch config
        const result = await getQuotaRoleConfig(interaction.guildId!, roleId);
        if (!result.config) {
            await interaction.editReply('❌ No quota configuration found for this role. Please set up basic config first.');
            return;
        }

        // Get member roles for authorization
        const memberRoles = member.roles.cache.map(r => r.id);

        // Step 1: Recalculate quota points based on current configuration
        await interaction.editReply('🔄 Recalculating quota points based on current configuration...');
        
        const recalcResult = await recalculateQuotaPoints(interaction.guildId!, roleId, {
            actorId: interaction.user.id,
            actorRoles: memberRoles,
        });

        // Step 2: Update panel with recalculated values
        await interaction.editReply('🔄 Updating quota panel...');
        await updateQuotaPanel(interaction.client, interaction.guildId!, roleId, result.config);

        await interaction.editReply(
            `✅ Quota panel has been updated successfully!\n` +
            `📊 Recalculated ${recalcResult.recalculated} events with a total of ${recalcResult.total_points} points.`
        );
    } catch (err) {
        console.error('Failed to refresh quota panel:', err);
        const msg = err instanceof BackendError ? err.message : 'Unknown error';
        await interaction.editReply(`❌ Failed to refresh panel: ${msg}`);
    }
}

/**
 * Handle quota_reset_panel button
 * Deletes the old panel and creates a fresh one with current settings
 */
export async function handleQuotaResetPanel(interaction: ButtonInteraction) {
    // Check panel expiry first
    const expiryCheck = checkPanelExpiry(interaction.customId);
    if (expiryCheck.expired) {
        await handleExpiredPanel(interaction, expiryCheck);
        return;
    }

    const customIdParts = interaction.customId.split(':');
    const roleId = customIdParts[1];
    // customIdParts[2] is the timestamp
    const authorizedUserId = customIdParts.length > 3 ? customIdParts[3] : null;

    if (!roleId) {
        await interaction.reply({ content: '❌ Invalid interaction data', flags: MessageFlags.Ephemeral });
        return;
    }

    // Check if only the command user can interact (only if user ID is specified)
    if (authorizedUserId && interaction.user.id !== authorizedUserId) {
        await interaction.reply({ 
            content: '❌ Only the user who ran the command can use these buttons.', 
            flags: MessageFlags.Ephemeral 
        });
        return;
    }

    // Check permissions (required even if no specific user restriction)
    const member = await interaction.guild?.members.fetch(interaction.user.id);
    if (!member?.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: '❌ Administrator permission required', flags: MessageFlags.Ephemeral });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        // Fetch config
        const result = await getQuotaRoleConfig(interaction.guildId!, roleId);
        if (!result.config) {
            await interaction.editReply('❌ No quota configuration found for this role. Please set up basic config first.');
            return;
        }

        const role = interaction.guild?.roles.cache.get(roleId);
        if (!role) {
            await interaction.editReply('❌ The configured Discord role no longer exists. It will be closed by automatic cleanup.');
            return;
        }
        const { memberIds } = await getRoleMembersWithCache(role);
        const reset = await manuallyResetQuotaPeriod(interaction.guildId!, roleId, {
            actor_user_id: interaction.user.id,
            actor_has_admin_permission: true,
            member_user_ids: memberIds,
        });
        for (const period of reset.periods) {
            await deliverQuotaPeriodLog(interaction.client, period);
        }

        // Refresh the existing panel against the newly persisted successor.
        const updatedResult = await getQuotaRoleConfig(interaction.guildId!, roleId);
        if (!updatedResult.config) {
            await interaction.editReply('❌ Failed to reset panel configuration.');
            return;
        }

        await updateQuotaPanel(interaction.client, interaction.guildId!, roleId, updatedResult.config);

        const activePeriod = updatedResult.active_period;
        const resetTimestamp = activePeriod ? Math.floor(new Date(activePeriod.ends_at).getTime() / 1000) : null;
        const catchUpText = reset.caught_up_count > 0
            ? `• Caught up ${reset.caught_up_count} overdue scheduled period${reset.caught_up_count === 1 ? '' : 's'} first\n`
            : '';
        await interaction.editReply(
            `✅ **Quota period reset successfully!**\n\n` +
            catchUpText +
            `• The current period was closed at the backend's stored reset time\n` +
            (resetTimestamp ? `• New period ends: <t:${resetTimestamp}:F> (<t:${resetTimestamp}:R>)\n` : '') +
            `• ${reset.periods.length} finalized period${reset.periods.length === 1 ? '' : 's'} persisted to history`
        );
    } catch (err) {
        logger.error('Failed to reset quota panel', { err, guildId: interaction.guildId, roleId });
        const msg = err instanceof BackendError ? err.message : 'Unknown error';
        await interaction.editReply(`❌ Failed to reset panel: ${msg}`);
    }
}

/**
 * Handle quota_delete_config button
 * Deletes the entire quota configuration for this role, including the panel
 */
export async function handleQuotaDeleteConfig(interaction: ButtonInteraction) {
    // Check panel expiry first
    const expiryCheck = checkPanelExpiry(interaction.customId);
    if (expiryCheck.expired) {
        await handleExpiredPanel(interaction, expiryCheck);
        return;
    }

    const customIdParts = interaction.customId.split(':');
    const roleId = customIdParts[1];
    // customIdParts[2] is the timestamp
    const authorizedUserId = customIdParts.length > 3 ? customIdParts[3] : null;

    if (!roleId) {
        await interaction.reply({ content: '❌ Invalid interaction data', flags: MessageFlags.Ephemeral });
        return;
    }

    // Check if only the command user can interact (only if user ID is specified)
    if (authorizedUserId && interaction.user.id !== authorizedUserId) {
        await interaction.reply({ 
            content: '❌ Only the user who ran the command can use these buttons.', 
            flags: MessageFlags.Ephemeral 
        });
        return;
    }

    // Check permissions (required even if no specific user restriction)
    const member = await interaction.guild?.members.fetch(interaction.user.id);
    if (!member?.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: '❌ Administrator permission required', flags: MessageFlags.Ephemeral });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        // Get current config to find panel message ID
        const result = await getQuotaRoleConfig(interaction.guildId!, roleId);
        const config = result.config;

        // Delete the panel message if it exists
        if (config?.panel_message_id) {
            try {
                const channels = await getGuildChannels(interaction.guildId!);
                const quotaChannelId = channels.channels['quota'];
                
                if (quotaChannelId) {
                    const quotaChannel = await interaction.guild?.channels.fetch(quotaChannelId);
                    if (quotaChannel?.isTextBased()) {
                        const panelMessage = await quotaChannel.messages.fetch(config.panel_message_id);
                        await panelMessage.delete();
                    }
                }
            } catch (err) {
                // Panel message might already be deleted, that's okay
                console.warn('Failed to delete panel message:', err);
            }
        }

        // Delete the quota configuration from the database
        const hasAdminPerm = member?.permissions.has(PermissionFlagsBits.Administrator);
        const quotaRole = interaction.guild?.roles.cache.get(roleId);
        const roleMembers = quotaRole ? (await getRoleMembersWithCache(quotaRole)).memberIds : undefined;
        const deleted = await deleteQuotaRoleConfig(interaction.guildId!, roleId, {
            actor_user_id: interaction.user.id,
            actor_has_admin_permission: hasAdminPerm,
            member_user_ids: roleMembers,
            deletion_reason: 'config_deleted',
        });
        for (const period of deleted.finalized_periods) {
            await deliverQuotaPeriodLog(interaction.client, period);
        }

        // Update the config panel to show no config exists
        const { embed, buttons } = await buildQuotaConfigPanel(interaction.guildId!, roleId, authorizedUserId || undefined);
        
        await interaction.message.edit({
            embeds: [embed],
            components: buttons,
        });

        await interaction.editReply({
            content: '✅ Quota configuration deleted successfully. The panel will not be recreated on quota updates.',
        });

    } catch (err) {
        console.error('Failed to delete quota config:', err);
        
        let errorMsg = '❌ Failed to delete quota configuration.';
        if (err instanceof BackendError) {
            if (err.status === 404) {
                errorMsg = '❌ No quota configuration found for this role.';
            } else if (err.status === 403) {
                errorMsg = '❌ You do not have permission to delete this quota configuration.';
            }
        }
        
        await interaction.editReply({ content: errorMsg });
    }
}

/**
 * Handle quota_config_stop button
 * Removes the interactive buttons but keeps the panel embed visible
 */
export async function handleQuotaConfigStop(interaction: ButtonInteraction) {
    // Check panel expiry first
    const expiryCheck = checkPanelExpiry(interaction.customId);
    if (expiryCheck.expired) {
        await handleExpiredPanel(interaction, expiryCheck);
        return;
    }

    const customIdParts = interaction.customId.split(':');
    const roleId = customIdParts[1];
    // customIdParts[2] is the timestamp
    const authorizedUserId = customIdParts.length > 3 ? customIdParts[3] : null;

    if (!roleId) {
        await interaction.reply({ content: '❌ Invalid interaction data', flags: MessageFlags.Ephemeral });
        return;
    }

    // Check if only the command user can interact (only if user ID is specified)
    if (authorizedUserId && interaction.user.id !== authorizedUserId) {
        await interaction.reply({ 
            content: '❌ Only the user who ran the command can use these buttons.', 
            flags: MessageFlags.Ephemeral 
        });
        return;
    }

    // Check permissions (required even if no specific user restriction)
    const member = await interaction.guild?.members.fetch(interaction.user.id);
    if (!member?.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: '❌ Administrator permission required', flags: MessageFlags.Ephemeral });
        return;
    }

    await interaction.deferUpdate();

    try {
        // Keep the current embed but remove the buttons
        await interaction.editReply({
            embeds: interaction.message.embeds,
            components: [], // Remove all buttons
        });
    } catch (err) {
        console.error('Failed to stop quota config panel:', err);
        await interaction.followUp({ 
            content: '❌ Failed to update panel.', 
            flags: MessageFlags.Ephemeral 
        });
    }
}

