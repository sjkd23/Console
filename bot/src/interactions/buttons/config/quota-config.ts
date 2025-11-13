import {
    ButtonInteraction,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    EmbedBuilder,
    MessageFlags,
    PermissionFlagsBits,
    ModalSubmitInteraction,
    StringSelectMenuBuilder,
    StringSelectMenuInteraction,
    ComponentType,
} from 'discord.js';
import { getQuotaRoleConfig, updateQuotaRoleConfig, setDungeonOverride, deleteDungeonOverride, getGuildChannels, BackendError } from '../../../lib/http.js';
import { DUNGEON_DATA } from '../../../constants/DungeonData.js';
import { updateQuotaPanel } from '../../../lib/quota-panel.js';

/**
 * Handle quota_config_basic button
 * Opens a modal to set required points and reset datetime
 */
export async function handleQuotaConfigBasic(interaction: ButtonInteraction) {
    const customIdParts = interaction.customId.split(':');
    const roleId = customIdParts[1];
    const authorizedUserId = customIdParts.length > 2 ? customIdParts[2] : null;

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

    // Format reset_at for display (YYYY-MM-DD HH:MM)
    let resetDisplay = '';
    if (config?.reset_at) {
        const resetDate = new Date(config.reset_at);
        resetDisplay = `${resetDate.getUTCFullYear()}-${String(resetDate.getUTCMonth() + 1).padStart(2, '0')}-${String(resetDate.getUTCDate()).padStart(2, '0')} ${String(resetDate.getUTCHours()).padStart(2, '0')}:${String(resetDate.getUTCMinutes()).padStart(2, '0')}`;
    }

    const modal = new ModalBuilder()
        .setCustomId(`quota_basic_modal:${roleId}`)
        .setTitle('Configure Basic Quota Settings');

    const requiredPointsInput = new TextInputBuilder()
        .setCustomId('required_points')
        .setLabel('Required Points Per Period')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g., 10')
        .setRequired(true)
        .setValue(config?.required_points?.toString() || '0');

    const resetAtInput = new TextInputBuilder()
        .setCustomId('reset_at')
        .setLabel('Reset Date & Time (UTC, YYYY-MM-DD HH:MM)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g., 2025-11-19 00:00')
        .setRequired(true)
        .setValue(resetDisplay);

    modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(requiredPointsInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(resetAtInput)
    );

    await interaction.showModal(modal);
}

/**
 * Handle quota_basic_modal submission
 */
export async function handleQuotaBasicModal(interaction: ModalSubmitInteraction) {
    const roleId = interaction.customId.split(':')[1];
    if (!roleId) {
        await interaction.reply({ content: '❌ Invalid interaction data', flags: MessageFlags.Ephemeral });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Parse inputs
    const requiredPoints = parseInt(interaction.fields.getTextInputValue('required_points'), 10);
    const resetAtStr = interaction.fields.getTextInputValue('reset_at').trim();

    // Validate required points
    if (isNaN(requiredPoints) || requiredPoints < 0) {
        await interaction.editReply('❌ Required points must be a non-negative number.');
        return;
    }

    // Parse and validate reset datetime (YYYY-MM-DD HH:MM)
    const dateTimeRegex = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/;
    const match = resetAtStr.match(dateTimeRegex);

    if (!match) {
        await interaction.editReply('❌ Invalid datetime format. Please use: YYYY-MM-DD HH:MM (e.g., 2025-11-19 00:00)');
        return;
    }

    const [, year, month, day, hour, minute] = match;
    const resetDate = new Date(Date.UTC(
        parseInt(year, 10),
        parseInt(month, 10) - 1, // Months are 0-indexed
        parseInt(day, 10),
        parseInt(hour, 10),
        parseInt(minute, 10),
        0
    ));

    // Validate date
    if (isNaN(resetDate.getTime())) {
        await interaction.editReply('❌ Invalid date. Please check your input.');
        return;
    }

    // Check permissions
    const member = await interaction.guild?.members.fetch(interaction.user.id);
    const hasAdminPerm = member?.permissions.has(PermissionFlagsBits.Administrator);

    try {
        await updateQuotaRoleConfig(interaction.guildId!, roleId, {
            actor_user_id: interaction.user.id,
            actor_has_admin_permission: hasAdminPerm,
            required_points: requiredPoints,
            reset_at: resetDate.toISOString(),
        });

        await interaction.editReply(
            `✅ **Quota configuration updated!**\n\n` +
            `**Required Points:** ${requiredPoints}\n` +
            `**Reset Time:** <t:${Math.floor(resetDate.getTime() / 1000)}:F> (<t:${Math.floor(resetDate.getTime() / 1000)}:R>)`
        );
    } catch (err) {
        console.error('Failed to update quota config:', err);
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
    const customIdParts = interaction.customId.split(':');
    const roleId = customIdParts[1];
    const authorizedUserId = customIdParts.length > 2 ? customIdParts[2] : null;

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

    // Fetch current overrides
    let dungeonOverrides: Record<string, number> = {};
    try {
        const result = await getQuotaRoleConfig(interaction.guildId!, roleId);
        dungeonOverrides = result.dungeon_overrides;
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
                description: override ? `Current: ${override} pts` : 'Default: 1 pt',
                emoji: override ? '⭐' : undefined,
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

    const embed = new EmbedBuilder()
        .setTitle('🗺️ Configure Dungeon Points')
        .setDescription(
            'Select a dungeon to set custom point values. By default, all dungeons are worth 1 point.\n\n' +
            `⭐ = Custom override set\n` +
            `Total overrides: ${Object.keys(dungeonOverrides).length}\n\n` +
            `**Categories:**\n` +
            `• Exaltation Dungeons (${exaltDungeons.length})\n` +
            `• Other Dungeons Part 1 (${misc1Dungeons.length})\n` +
            `• Other Dungeons Part 2 (${misc2Dungeons.length})`
        )
        .setColor(0x5865F2);

    await interaction.editReply({
        embeds: [embed],
        components: rows.slice(0, 5), // Discord max 5 action rows
    });
}

/**
 * Handle quota_select_dungeon select menu
 */
export async function handleQuotaSelectDungeon(interaction: StringSelectMenuInteraction) {
    const roleId = interaction.customId.split(':')[1];
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

    const modal = new ModalBuilder()
        .setCustomId(`quota_dungeon_modal:${roleId}:${dungeonKey}`)
        .setTitle(`${dungeon.dungeonName} Points`);

    const pointsInput = new TextInputBuilder()
        .setCustomId('points')
        .setLabel(`Point Value (0 to remove override)`)
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g., 2')
        .setRequired(true)
        .setValue(currentOverride?.toString() || '1');

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

    if (!roleId || !dungeonKey) {
        await interaction.reply({ content: '❌ Invalid interaction data', flags: MessageFlags.Ephemeral });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const points = parseInt(interaction.fields.getTextInputValue('points'), 10);

    if (isNaN(points) || points < 0) {
        await interaction.editReply('❌ Points must be a non-negative number.');
        return;
    }

    const member = await interaction.guild?.members.fetch(interaction.user.id);
    const hasAdminPerm = member?.permissions.has(PermissionFlagsBits.Administrator);

    try {
        if (points === 0) {
            // Remove override
            await deleteDungeonOverride(interaction.guildId!, roleId, dungeonKey, {
                actor_user_id: interaction.user.id,
                actor_has_admin_permission: hasAdminPerm,
            });
            await interaction.editReply(`✅ Removed custom point override for **${dungeonKey}** (reverted to default: 1 pt)`);
        } else {
            // Set override
            await setDungeonOverride(interaction.guildId!, roleId, dungeonKey, {
                actor_user_id: interaction.user.id,
                actor_has_admin_permission: hasAdminPerm,
                points,
            });
            await interaction.editReply(`✅ Set **${dungeonKey}** to **${points} point${points === 1 ? '' : 's'}**`);
        }
    } catch (err) {
        console.error('Failed to update dungeon override:', err);
        const msg = err instanceof BackendError ? err.message : 'Unknown error';
        await interaction.editReply(`❌ Failed to update dungeon override: ${msg}`);
    }
}

/**
 * Handle quota_refresh_panel button
 * Updates the leaderboard panel in the quota channel
 */
export async function handleQuotaRefreshPanel(interaction: ButtonInteraction) {
    const customIdParts = interaction.customId.split(':');
    const roleId = customIdParts[1];
    const authorizedUserId = customIdParts.length > 2 ? customIdParts[2] : null;

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

        // Update panel
        await updateQuotaPanel(interaction.client, interaction.guildId!, roleId, result.config);

        await interaction.editReply('✅ Quota panel has been updated successfully!');
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
    const customIdParts = interaction.customId.split(':');
    const roleId = customIdParts[1];
    const authorizedUserId = customIdParts.length > 2 ? customIdParts[2] : null;

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

        // Delete old panel message if it exists
        if (result.config.panel_message_id) {
            try {
                const channels = await getGuildChannels(interaction.guildId!);
                const quotaChannelId = channels.channels['quota'];

                if (quotaChannelId) {
                    const guild = interaction.guild!;
                    const quotaChannel = await guild.channels.fetch(quotaChannelId);

                    if (quotaChannel?.isTextBased()) {
                        const oldMessage = await (quotaChannel as any).messages.fetch(result.config.panel_message_id);
                        if (oldMessage) {
                            await oldMessage.delete();
                            console.log(`[Quota Panel] Deleted old panel message ${result.config.panel_message_id}`);
                        }
                    }
                }
            } catch (err) {
                console.log(`[Quota Panel] Could not delete old panel message:`, err);
                // Continue anyway - we'll create a new panel
            }
        }

        // Reset the quota period by updating created_at to NOW and reset_at to 7 days from now
        // This starts a fresh quota period
        const hasAdminPerm = member.permissions.has(PermissionFlagsBits.Administrator);
        const now = new Date();
        const newResetAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days from now

        await updateQuotaRoleConfig(interaction.guildId!, roleId, {
            actor_user_id: interaction.user.id,
            actor_has_admin_permission: hasAdminPerm,
            panel_message_id: null,
            created_at: now.toISOString(), // Start the period NOW
            reset_at: newResetAt.toISOString(), // End in 7 days
        });

        // Fetch updated config (with null panel_message_id and new period)
        const updatedResult = await getQuotaRoleConfig(interaction.guildId!, roleId);
        if (!updatedResult.config) {
            await interaction.editReply('❌ Failed to reset panel configuration.');
            return;
        }

        // Create new panel
        await updateQuotaPanel(interaction.client, interaction.guildId!, roleId, updatedResult.config);

        const resetTimestamp = Math.floor(newResetAt.getTime() / 1000);
        await interaction.editReply(
            `✅ **Quota period reset successfully!**\n\n` +
            `• Period started: NOW\n` +
            `• Period ends: <t:${resetTimestamp}:F> (<t:${resetTimestamp}:R>)\n` +
            `• Previous stats have been cleared\n` +
            `• New panel created in quota channel`
        );
    } catch (err) {
        console.error('Failed to reset quota panel:', err);
        const msg = err instanceof BackendError ? err.message : 'Unknown error';
        await interaction.editReply(`❌ Failed to reset panel: ${msg}`);
    }
}

/**
 * Handle quota_config_stop button
 * Removes the interactive buttons but keeps the panel embed visible
 */
export async function handleQuotaConfigStop(interaction: ButtonInteraction) {
    const customIdParts = interaction.customId.split(':');
    const roleId = customIdParts[1];
    const authorizedUserId = customIdParts.length > 2 ? customIdParts[2] : null;

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

