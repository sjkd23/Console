// src/commands/headcount.ts
import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    EmbedBuilder,
    MessageFlags,
    type Guild,
} from 'discord.js';
import type { SlashCommand } from '../_types.js';
import { ensureGuildContext } from '../../lib/utilities/interaction-helpers.js';
import { formatErrorMessage } from '../../lib/errors/error-handler.js';
import type { DungeonInfo } from '../../constants/dungeons/dungeon-types.js';
import { logRaidCreation } from '../../lib/logging/raid-logger.js';
import { registerHeadcount } from '../../lib/state/active-headcount-tracker.js';
import { createLogger } from '../../lib/logging/logger.js';
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
import { buildHeadcountActionRows } from '../../lib/ui/headcount-components.js';

const logger = createLogger('Headcount');
const HEADCOUNT_INTEREST_PROMPT = 'Click the dungeon(s) you would be interested in joining!';

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
    guild: Guild,
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
                .setFooter({ text: HEADCOUNT_INTEREST_PROMPT })
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
                .setFooter({ text: HEADCOUNT_INTEREST_PROMPT })
                .setTimestamp(new Date());
        }

        const panelToken = Date.now().toString();
        const buttonRows = buildHeadcountActionRows(selectedDungeons, panelToken);

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
                selectedDungeons.map(d => ({
                    codeName: d.codeName,
                    dungeonName: d.dungeonName,
                })),
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
