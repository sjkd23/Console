// src/commands/headcount.ts
import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags
} from 'discord.js';
import type { SlashCommand } from '../_types.js';
import { ensureGuildContext } from '../../lib/utilities/interaction-helpers.js';
import { formatErrorMessage } from '../../lib/errors/error-handler.js';
import type { DungeonInfo } from '../../constants/dungeons/dungeon-types.js';
import { getDungeonKeyEmojiIdentifier, getDungeonKeyEmoji } from '../../lib/utilities/key-emoji-helpers.js';
import { logRaidCreation } from '../../lib/logging/raid-logger.js';
import { registerHeadcount } from '../../lib/state/active-headcount-tracker.js';
import { createLogger } from '../../lib/logging/logger.js';
import { getReactionInfo } from '../../constants/emojis/MappedAfkCheckReactions.js';
import {
    checkOrganizerActiveActivities,
    buildActiveRunErrorForHeadcount,
    buildActiveHeadcountErrorForHeadcount
} from '../../lib/utilities/organizer-activity-checker.js';
import { fetchConfiguredRaidChannel } from '../../lib/utilities/channel-helpers.js';
import { buildRunMessageContent } from '../../lib/utilities/run-message-helpers.js';
import { MULTI_DUNGEON_HEADCOUNT_TITLE } from '../../lib/utilities/headcount-conversion.js';
import { sendHeadcountOrganizerPanelAsFollowUp } from '../../interactions/buttons/raids/headcount-organizer-panel.js';
import { autoJoinOrganizerToHeadcount } from '../../lib/utilities/auto-join-helpers.js';
import { collectDungeonSelection } from '../../lib/ui/dungeon-selection-panel.js';
import { resolveDungeonRolePingIds } from '../../lib/utilities/dungeon-role-pings.js';
import { setDungeonCodes } from '../../lib/state/headcount-state.js';
import { validateHeadcountDungeons } from '../../constants/dungeons/dungeon-taxonomy.js';
import { getPhysicalDungeonKeyOffers } from '../../lib/utilities/dungeon-key-offers.js';

const logger = createLogger('Headcount');

/**
 * Get emoji identifier for a key reaction (by mapKey)
 */
function getKeyReactionEmojiIdentifier(mapKey: string): string | undefined {
    const reactionInfo = getReactionInfo(mapKey);
    return reactionInfo?.emojiInfo?.identifier;
}

/**
 * Format key button label for display
 */
function formatKeyButtonLabel(mapKey: string): string {
    const specialCases: Record<string, string> = {
        'WC_INC': 'Inc',
        'SHIELD_RUNE': 'Shield',
        'SWORD_RUNE': 'Sword',
        'HELM_RUNE': 'Helm',
    };
    
    return specialCases[mapKey] || 'Key';
}

export const headcount: SlashCommand = {
    requiredRole: 'organizer',
    data: new SlashCommandBuilder()
        .setName('headcount')
        .setDescription('Create a lightweight headcount panel to gauge interest for upcoming runs'),

    async run(interaction: ChatInputCommandInteraction): Promise<void> {
        const guild = await ensureGuildContext(interaction);
        if (!guild) return;

        // Show ephemeral dungeon selection dropdowns
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // Check if organizer has any active runs or headcounts
        // Use specialized error messages for headcount creation context
        const activityCheck = await checkOrganizerActiveActivities(interaction, guild.id, interaction.user.id);
        
        if (activityCheck.hasActiveRun) {
            // Use headcount-specific error message for active runs
            // Note: We need to fetch the run details again to get the proper format
            // This is a bit redundant but maintains the specific wording
            await interaction.editReply(activityCheck.errorMessage!);
            return;
        }
        
        if (activityCheck.hasActiveHeadcount) {
            // Use headcount-specific error message for active headcount
            await interaction.editReply(activityCheck.errorMessage!);
            return;
        }

        const selectedDungeons = await collectDungeonSelection(interaction, {
            namespace: 'headcount-select',
            title: 'Select dungeons for the headcount',
            instructions: 'Choose up to 5 dungeons. Any mixture of selectable dungeons is allowed for headcounts.',
            confirmLabel: 'Create Headcount',
            validate: validateHeadcountDungeons,
        });
        if (!selectedDungeons) return;

        const confirmActivityCheck = await checkOrganizerActiveActivities(interaction, guild.id, interaction.user.id);
        if (confirmActivityCheck.errorMessage) {
            await interaction.editReply({ content: confirmActivityCheck.errorMessage, components: [] });
            return;
        }

        await createHeadcountPanel(interaction, guild, selectedDungeons);
    }
};

/**
 * Create and post the headcount panel
 */
async function createHeadcountPanel(
    interaction: ChatInputCommandInteraction,
    guild: any,
    selectedDungeons: DungeonInfo[]
): Promise<void> {
    try {
        const isSingleDungeon = selectedDungeons.length === 1;
        const dungeon = selectedDungeons[0]; // First dungeon for single-dungeon mode
        
        // Build the headcount panel embed
        let embed: EmbedBuilder;
        
        if (isSingleDungeon) {
            // Single dungeon: Make it look like a run panel
            embed = new EmbedBuilder()
                .setTitle(`🎯 Headcount: ${dungeon.dungeonName}`)
                .setDescription(`Organizer: <@${interaction.user.id}>`)
                // Interested count hidden from public panel - shown in organizer panel only
                // .addFields({ name: 'Interested', value: '0', inline: false })
                .setTimestamp(new Date());
            
            // Add color and thumbnail if available
            if (dungeon.dungeonColors?.length) {
                embed.setColor(dungeon.dungeonColors[0]);
            } else {
                embed.setColor(0x5865F2);
            }
            
            if (dungeon.portalLink?.url) {
                embed.setThumbnail(dungeon.portalLink.url);
            }
            
            // Note: We don't add a "Keys" field anymore - key details are shown in the description
        } else {
            // Multiple dungeons: Cleaner multi-dungeon display
            const dungeonList = selectedDungeons
                .map(d => `🔹 **${d.dungeonName}**`)
                .join('\n');
            
            embed = new EmbedBuilder()
                .setTitle(MULTI_DUNGEON_HEADCOUNT_TITLE)
                .setColor(0x5865F2)
                .setDescription(
                    `Organizer: <@${interaction.user.id}>\n\n` +
                    `**Dungeons:**\n${dungeonList}`
                )
                // Interested count hidden from public panel - shown in organizer panel only
                // .addFields(
                //     { name: 'Interested', value: '0', inline: true },
                //     { name: 'Total Keys', value: '0', inline: true }
                // )
                .setTimestamp(new Date());
        }

        // Create action buttons
        const joinButton = new ButtonBuilder()
            .setCustomId(`headcount:join:${Date.now()}`)
            .setLabel('Join')
            .setStyle(ButtonStyle.Success);

        const orgButton = new ButtonBuilder()
            .setCustomId(`headcount:org:${Date.now()}`)
            .setLabel('Organizer Panel')
            .setStyle(ButtonStyle.Secondary);

        // Build button rows based on single vs multi-dungeon
        const buttonRows: ActionRowBuilder<ButtonBuilder>[] = [];
        
        if (isSingleDungeon) {
            // Single dungeon: Smart layout based on number of keys
            const timestamp = Date.now();
            const keyButtons: ButtonBuilder[] = [];
            
            // Create buttons only for real physical key offers (supports Oryx 3's multiple keys).
            for (const { reaction: keyReaction } of getPhysicalDungeonKeyOffers([dungeon])) {
                const keyEmojiId = getKeyReactionEmojiIdentifier(keyReaction.mapKey);
                const keyLabel = formatKeyButtonLabel(keyReaction.mapKey);

                const keyButton = new ButtonBuilder()
                    .setCustomId(`headcount:key:${timestamp}:${dungeon.codeName}:${keyReaction.mapKey}`)
                    .setLabel(keyLabel)
                    .setStyle(ButtonStyle.Secondary);

                if (keyEmojiId) {
                    keyButton.setEmoji(keyEmojiId);
                }

                keyButtons.push(keyButton);
            }
            
            // Layout logic: Max 5 buttons per row
            // Row 1: Join + up to 3 keys + Organizer Panel (if total <= 5)
            // Otherwise: Row 1: Join + some keys, Row 2: remaining keys + Organizer Panel
            const totalButtons = 2 + keyButtons.length; // Join + keys + Organizer Panel
            
            if (totalButtons <= 5) {
                // All buttons fit in one row: Join, keys, Organizer Panel
                const mainRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    joinButton,
                    ...keyButtons,
                    orgButton
                );
                buttonRows.push(mainRow);
            } else {
                // Need multiple rows
                // Row 1: Join + first keys (fill to 5 buttons)
                const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(joinButton);
                let row1Space = 4; // 5 total - 1 (join button)
                const row1Keys = keyButtons.slice(0, row1Space);
                row1.addComponents(...row1Keys);
                buttonRows.push(row1);
                
                // Row 2: Remaining keys + Organizer Panel
                const remainingKeys = keyButtons.slice(row1Space);
                const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    ...remainingKeys,
                    orgButton
                );
                buttonRows.push(row2);
            }
        } else {
            // Multiple dungeons: Join and Organizer Panel on first row
            const mainRow = new ActionRowBuilder<ButtonBuilder>().addComponents(joinButton, orgButton);
            buttonRows.push(mainRow);
            
            // Collect all key buttons from all selected dungeons
            const keyButtons: ButtonBuilder[] = [];
            const timestamp = Date.now();
            
            for (const { dungeon: selectedDungeon, reaction: keyReaction } of getPhysicalDungeonKeyOffers(selectedDungeons)) {
                const keyEmojiId = getKeyReactionEmojiIdentifier(keyReaction.mapKey);

                // Format label based on whether dungeon has multiple key types
                let label: string;
                if (selectedDungeon.keyReactions.length === 1) {
                    // Single key: show dungeon name
                    label = selectedDungeon.dungeonName.length > 15
                        ? selectedDungeon.dungeonName.substring(0, 13) + '...'
                        : selectedDungeon.dungeonName;
                } else {
                    // Multiple keys: show just the key type name
                    label = formatKeyButtonLabel(keyReaction.mapKey);
                }

                const keyButton = new ButtonBuilder()
                    .setCustomId(`headcount:key:${timestamp}:${selectedDungeon.codeName}:${keyReaction.mapKey}`)
                    .setLabel(label)
                    .setStyle(ButtonStyle.Secondary);

                // Add emoji if available
                if (keyEmojiId) {
                    keyButton.setEmoji(keyEmojiId);
                }

                keyButtons.push(keyButton);
            }

            // Smart button layout: max 5 buttons per row, up to 4 additional rows
            // Total max: 5 buttons (main row) + 20 buttons (4 additional rows) = 25 total
            let currentRow: ButtonBuilder[] = [];
            
            for (let i = 0; i < keyButtons.length; i++) {
                currentRow.push(keyButtons[i]);
                
                // Create new row when we have 5 buttons or at the end
                if (currentRow.length === 5 || i === keyButtons.length - 1) {
                    buttonRows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...currentRow));
                    currentRow = [];
                }
            }
        }

        // Get the configured raid channel using helper
        const raidChannel = await fetchConfiguredRaidChannel(guild, interaction);
        if (!raidChannel) {
            // Error already sent by helper
            return;
        }

        // Post headcount panel to raid channel
        // Build content with @here and any configured dungeon role pings
        const rolePings = await resolveDungeonRolePingIds(guild, selectedDungeons.map(dungeon => dungeon.codeName));
        
        const content = buildRunMessageContent({
            selectedDungeons: selectedDungeons.map(dungeon => ({ dungeonLabel: dungeon.dungeonName })),
            additionalPingRoleIds: rolePings,
        });
        
        const sent = await raidChannel.send({
                content,
                embeds: [embed],
                components: buttonRows
            });

            // Register the active headcount
            registerHeadcount(
                guild.id,
                interaction.user.id,
                sent.id,
                sent.channelId,
                selectedDungeons.map(d => d.dungeonName),
                selectedDungeons.map(d => d.codeName)
            );
            setDungeonCodes(sent.id, selectedDungeons.map(dungeon => dungeon.codeName));

        // Confirm to organizer
        await interaction.editReply({
            content: `✅ Headcount created: ${sent.url}`,
            components: []
        });

        const dungeonCodes = selectedDungeons.map(dungeon => dungeon.codeName);
        
        // Show the organizer panel IMMEDIATELY as a followUp
        // This allows the organizer to see the panel right away
        // The panel will auto-refresh when auto-join completes
        await sendHeadcountOrganizerPanelAsFollowUp(interaction, sent, embed, dungeonCodes);

        // Run background tasks in parallel (don't block the user experience)
        // These will complete after the panel is already visible
        Promise.all([
            // Auto-join organizer (updates embed)
            autoJoinOrganizerToHeadcount(
                interaction.client,
                guild,
                sent,
                interaction.user.id,
                interaction.user.username,
                selectedDungeons.map(d => d.dungeonName),
                sent.id // Use message ID as panel timestamp
            ).catch(err => {
                logger.error('Failed to auto-join organizer to headcount', {
                    guildId: guild.id,
                    messageId: sent.id,
                    error: err instanceof Error ? err.message : String(err)
                });
            }),
            
            // Log to raid-log channel
            logRaidCreation(
                interaction.client,
                {
                    guildId: guild.id,
                    organizerId: interaction.user.id,
                    organizerUsername: interaction.user.username,
                    dungeonName: selectedDungeons.map(d => d.dungeonName).join(', '),
                    type: 'headcount',
                    panelTimestamp: sent.id // Use message ID as unique identifier
                }
            ).catch(err => {
                logger.error('Failed to log headcount creation to raid-log', {
                    guildId: guild.id,
                    messageId: sent.id,
                    error: err instanceof Error ? err.message : String(err)
                });
            })
        ]).catch(err => {
            // Catch any unhandled errors in the parallel batch
            logger.error('Error in background tasks after headcount creation', { 
                err, guildId: guild.id, messageId: sent.id 
            });
        });

    } catch (err) {
        // Error creating headcount
        const errorMessage = formatErrorMessage({
            error: err,
            baseMessage: 'Failed to create headcount panel',
            errorHandlers: {},
        });
        await interaction.editReply({
            content: errorMessage,
            components: []
        });
    }
}
