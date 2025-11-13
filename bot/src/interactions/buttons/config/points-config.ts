// bot/src/interactions/buttons/points-config.ts
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
    Message,
} from 'discord.js';
import { getRaiderPointsConfig, setRaiderPoints, deleteRaiderPoints, BackendError } from '../../../lib/http.js';
import { DUNGEON_DATA } from '../../../constants/DungeonData.js';
import { buildConfigPointsPanel } from '../../../lib/configpoints-panel.js';

/**
 * Helper function to build the dungeon selection dropdown panel
 */
async function buildDungeonSelectorPanel(guildId: string): Promise<{
    embed: EmbedBuilder;
    rows: ActionRowBuilder<StringSelectMenuBuilder>[];
}> {
    // Fetch current configuration
    let dungeonPoints: Record<string, number> = {};
    try {
        const result = await getRaiderPointsConfig(guildId);
        dungeonPoints = result.dungeon_points;
    } catch { }

    // Split dungeons into categories
    const exaltDungeons = DUNGEON_DATA.filter(d => d.dungeonCategory === 'Exaltation Dungeons');
    const otherDungeons = DUNGEON_DATA.filter(d => d.dungeonCategory !== 'Exaltation Dungeons');
    
    // Split other dungeons into two groups (25 each max)
    const misc1Dungeons = otherDungeons.slice(0, 25);
    const misc2Dungeons = otherDungeons.slice(25, 50);

    const createOptions = (dungeons: typeof DUNGEON_DATA) => 
        Array.from(dungeons).map(dungeon => {
            const points = dungeonPoints[dungeon.codeName];
            const displayPoints = points !== undefined ? points : 1; // Default is 1
            const isCustom = points !== undefined && points !== 1;
            return {
                label: dungeon.dungeonName,
                value: dungeon.codeName,
                description: points !== undefined ? `Current: ${points} pts` : 'Default: 1 pt',
                emoji: isCustom ? '⭐' : undefined,
            };
        });

    const rows: ActionRowBuilder<StringSelectMenuBuilder>[] = [];

    // Exaltation dungeons dropdown
    if (exaltDungeons.length > 0) {
        const exaltMenu = new StringSelectMenuBuilder()
            .setCustomId('points_select_dungeon_exalt')
            .setPlaceholder('Exaltation Dungeons...')
            .addOptions(createOptions(exaltDungeons));
        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(exaltMenu));
    }

    // Misc 1 dungeons dropdown
    if (misc1Dungeons.length > 0) {
        const misc1Menu = new StringSelectMenuBuilder()
            .setCustomId('points_select_dungeon_misc1')
            .setPlaceholder('Other Dungeons (Part 1)...')
            .addOptions(createOptions(misc1Dungeons));
        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(misc1Menu));
    }

    // Misc 2 dungeons dropdown (if needed)
    if (misc2Dungeons.length > 0) {
        const misc2Menu = new StringSelectMenuBuilder()
            .setCustomId('points_select_dungeon_misc2')
            .setPlaceholder('Other Dungeons (Part 2)...')
            .addOptions(createOptions(misc2Dungeons));
        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(misc2Menu));
    }

    const configuredCount = Object.values(dungeonPoints).filter(p => p !== undefined && p !== 1).length;
    
    const embed = new EmbedBuilder()
        .setTitle('🗺️ Configure Raider Points per Dungeon')
        .setDescription(
            'Select a dungeon to set custom point values for **raiders** who complete it.\n\n' +
            'By default, all dungeons award **1 point** per completion.\n\n' +
            `⭐ = Custom override set (${configuredCount} dungeon${configuredCount === 1 ? '' : 's'})\n\n` +
            `**Categories:**\n` +
            `• Exaltation Dungeons (${exaltDungeons.length})\n` +
            `• Other Dungeons Part 1 (${misc1Dungeons.length})\n` +
            `• Other Dungeons Part 2 (${misc2Dungeons.length})`
        )
        .setColor(0x3498db);

    return { embed, rows };
}

/**
 * Handle points_config_dungeons button
 * Shows select menus to choose a dungeon to configure
 * Split into Exaltation, Misc 1, and Misc 2 to handle Discord's 25-option limit
 */
export async function handlePointsConfigDungeons(interaction: ButtonInteraction) {
    // Extract user ID from custom ID if present
    const customIdParts = interaction.customId.split(':');
    const authorizedUserId = customIdParts.length > 1 ? customIdParts[1] : null;

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

    const { embed, rows } = await buildDungeonSelectorPanel(interaction.guildId!);

    // Send the dropdown panel and get the message
    const reply = await interaction.editReply({
        embeds: [embed],
        components: rows.slice(0, 5), // Discord max 5 action rows
    });

    // Store the main panel message ID in the dropdown's select menu customIds
    // So we can refresh it later after modal submission
    const mainPanelMessageId = interaction.message.id;
    
    // Update the select menus to include the main panel message ID
    const updatedRows = rows.slice(0, 5).map(row => {
        const menu = row.components[0] as StringSelectMenuBuilder;
        const currentId = menu.data.custom_id!;
        // Append main panel message ID to custom_id
        menu.setCustomId(`${currentId}:${mainPanelMessageId}`);
        return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
    });

    await interaction.editReply({
        embeds: [embed],
        components: updatedRows,
    });
}

/**
 * Handle points_select_dungeon select menu
 */
export async function handlePointsSelectDungeon(interaction: StringSelectMenuInteraction) {
    const dungeonKey = interaction.values[0];

    if (!dungeonKey) {
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

    // Fetch current configuration
    let currentPoints: number | undefined;
    try {
        const result = await getRaiderPointsConfig(interaction.guildId!);
        currentPoints = result.dungeon_points[dungeonKey];
    } catch { }

    // Default is 1 if not configured
    const displayValue = currentPoints !== undefined ? currentPoints.toString() : '1';

    // Extract main panel message ID from customId if available
    const customIdParts = interaction.customId.split(':');
    const mainPanelMessageId = customIdParts.length > 1 ? customIdParts[1] : '';
    const dropdownMessageId = interaction.message.id;

    // Encode both message IDs in the modal customId
    const modal = new ModalBuilder()
        .setCustomId(`points_dungeon_modal:${dungeonKey}:${dropdownMessageId}:${mainPanelMessageId}`)
        .setTitle(`${dungeon.dungeonName} Points`);

    const pointsInput = new TextInputBuilder()
        .setCustomId('points')
        .setLabel('Raider Point Value (default: 1)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g., 5')
        .setRequired(true)
        .setValue(displayValue);

    modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(pointsInput)
    );

    await interaction.showModal(modal);
}

/**
 * Handle points_dungeon_modal submission
 */
export async function handlePointsDungeonModal(interaction: ModalSubmitInteraction) {
    const parts = interaction.customId.split(':');
    const dungeonKey = parts[1];
    const dropdownMessageId = parts[2];
    const mainPanelMessageId = parts[3];

    if (!dungeonKey) {
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
        if (points === 1) {
            // Remove configuration (revert to default 1)
            await deleteRaiderPoints(interaction.guildId!, dungeonKey, {
                actor_user_id: interaction.user.id,
                actor_has_admin_permission: hasAdminPerm,
            });
            await interaction.editReply(`✅ Removed raider points override for **${dungeonKey}** (reverted to default: 1 pt)`);
        } else {
            // Set configuration
            await setRaiderPoints(interaction.guildId!, dungeonKey, {
                actor_user_id: interaction.user.id,
                actor_has_admin_permission: hasAdminPerm,
                points,
            });
            await interaction.editReply(`✅ Set **${dungeonKey}** to award **${points} point${points === 1 ? '' : 's'}** to raiders`);
        }

        // Refresh the dropdown selector panel using webhook
        if (dropdownMessageId) {
            try {
                const { embed, rows } = await buildDungeonSelectorPanel(interaction.guildId!);
                
                // Update customIds to include main panel message ID
                const updatedRows = rows.slice(0, 5).map(row => {
                    const menu = row.components[0] as StringSelectMenuBuilder;
                    const currentId = menu.data.custom_id!;
                    // Append main panel message ID to custom_id
                    menu.setCustomId(`${currentId}:${mainPanelMessageId}`);
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

        // Refresh the original /configpoints panel using webhook
        if (mainPanelMessageId) {
            try {
                // Don't include user ID when refreshing - anyone with admin can use the buttons
                const { embed: mainEmbed, buttons: mainButtons } = await buildConfigPointsPanel(interaction.guildId!);
                
                await interaction.webhook.editMessage(mainPanelMessageId, {
                    embeds: [mainEmbed],
                    components: [mainButtons],
                });
            } catch (err) {
                console.error('Failed to refresh main config panel:', err);
                // Non-critical, continue
            }
        }

    } catch (err) {
        console.error('Failed to update raider points:', err);
        const msg = err instanceof BackendError ? err.message : 'Unknown error';
        await interaction.editReply(`❌ Failed to update raider points: ${msg}`);
    }
}

/**
 * Handle points_config_stop button
 * Removes the interactive buttons but keeps the panel embed visible
 */
export async function handlePointsConfigStop(interaction: ButtonInteraction) {
    // Extract user ID from custom ID if present
    const customIdParts = interaction.customId.split(':');
    const authorizedUserId = customIdParts.length > 1 ? customIdParts[1] : null;

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
        // Get the current embed and remove the buttons
        const { embed } = await buildConfigPointsPanel(interaction.guildId!);
        
        await interaction.editReply({
            embeds: [embed],
            components: [], // Remove all buttons
        });
    } catch (err) {
        console.error('Failed to stop config panel:', err);
        await interaction.followUp({ 
            content: '❌ Failed to update panel.', 
            flags: MessageFlags.Ephemeral 
        });
    }
}

