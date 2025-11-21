// bot/src/commands/leaderboard.ts
import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    MessageFlags,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ButtonInteraction,
} from 'discord.js';
import type { SlashCommand } from './_types.js';
import { getLeaderboard } from '../lib/utilities/http.js';
import { DUNGEON_DATA } from '../constants/dungeons/DungeonData.js';
import { dungeonByCode } from '../constants/dungeons/dungeon-helpers.js';
import { ensureGuildContext } from '../lib/utilities/interaction-helpers.js';
import { formatErrorMessage } from '../lib/errors/error-handler.js';

const ENTRIES_PER_PAGE = 25;

/**
 * Create pagination buttons for leaderboard
 */
function createLeaderboardButtons(
    currentPage: number,
    totalPages: number,
    disabled = false
): ActionRowBuilder<ButtonBuilder>[] {
    const navigationRow = new ActionRowBuilder<ButtonBuilder>();

    navigationRow.addComponents(
        new ButtonBuilder()
            .setCustomId('lb_first')
            .setEmoji('⏮️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled || currentPage === 0 || totalPages === 0),
        new ButtonBuilder()
            .setCustomId('lb_prev')
            .setEmoji('◀️')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(disabled || currentPage === 0 || totalPages === 0),
        new ButtonBuilder()
            .setCustomId('lb_page')
            .setLabel(totalPages > 0 ? `${currentPage + 1} / ${totalPages}` : '0 / 0')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true),
        new ButtonBuilder()
            .setCustomId('lb_next')
            .setEmoji('▶️')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(disabled || currentPage === totalPages - 1 || totalPages === 0),
        new ButtonBuilder()
            .setCustomId('lb_last')
            .setEmoji('⏭️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled || currentPage === totalPages - 1 || totalPages === 0)
    );

    // Stop button in separate row (Discord limits 5 buttons per row)
    const controlRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId('lb_stop')
            .setLabel('Stop')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(disabled)
    );

    return [navigationRow, controlRow];
}

/**
 * Setup pagination for leaderboard
 */
async function setupLeaderboardPagination(
    interaction: ChatInputCommandInteraction,
    embeds: EmbedBuilder[],
    userId: string,
    timeout = 600000
): Promise<void> {
    let currentPage = 0;
    const totalPages = embeds.length;

    if (totalPages === 0) {
        return;
    }

    const message = await interaction.editReply({
        embeds: [embeds[currentPage]],
        components: createLeaderboardButtons(currentPage, totalPages),
    });

    // Create collector for button interactions
    const collector = message.createMessageComponentCollector({
        filter: (i) => {
            // Only allow the user who invoked the command to use buttons
            if (i.user.id !== userId) {
                i.reply({
                    content: 'You can\'t use these buttons. Use `/leaderboard` to view your own.',
                    ephemeral: true,
                }).catch(() => {});
                return false;
            }
            return i.customId.startsWith('lb_');
        },
        time: timeout,
    });

    collector.on('collect', async (buttonInteraction: ButtonInteraction) => {
        // Handle stop button - remove all buttons
        if (buttonInteraction.customId === 'lb_stop') {
            collector.stop('stopped');
            await buttonInteraction.update({
                components: [],
            });
            return;
        }

        let needsUpdate = false;

        // Handle navigation
        switch (buttonInteraction.customId) {
            case 'lb_first':
                if (currentPage !== 0) {
                    currentPage = 0;
                    needsUpdate = true;
                }
                break;
            case 'lb_prev':
                if (currentPage > 0) {
                    currentPage = Math.max(0, currentPage - 1);
                    needsUpdate = true;
                }
                break;
            case 'lb_next':
                if (currentPage < totalPages - 1) {
                    currentPage = Math.min(totalPages - 1, currentPage + 1);
                    needsUpdate = true;
                }
                break;
            case 'lb_last':
                if (currentPage !== totalPages - 1) {
                    currentPage = totalPages - 1;
                    needsUpdate = true;
                }
                break;
        }

        if (needsUpdate) {
            // Update message with new page
            await buttonInteraction.update({
                embeds: [embeds[currentPage]],
                components: createLeaderboardButtons(currentPage, totalPages),
            });
        } else {
            // Acknowledge the interaction even if nothing changed
            await buttonInteraction.deferUpdate();
        }
    });

    collector.on('end', async (collected, reason) => {
        // Only disable buttons if timeout occurred (not if user clicked Stop)
        if (reason !== 'stopped') {
            try {
                await interaction.editReply({
                    components: createLeaderboardButtons(currentPage, totalPages, true),
                });
            } catch (err) {
                // Message might have been deleted
                console.warn('[Leaderboard] Failed to disable buttons:', err);
            }
        }
    });
}

/**
 * /leaderboard - View leaderboards for runs organized, keys popped, or dungeon completions
 */
export const leaderboard: SlashCommand = {
    requiredRole: 'verified_raider',
    data: new SlashCommandBuilder()
        .setName('leaderboard')
        .setDescription('View leaderboards for various activities')
        .addStringOption(option =>
            option
                .setName('category')
                .setDescription('The category to view')
                .setRequired(true)
                .addChoices(
                    { name: 'Runs Organized', value: 'runs_organized' },
                    { name: 'Keys Popped', value: 'keys_popped' },
                    { name: 'Dungeon Completions', value: 'dungeon_completions' },
                    { name: 'Points', value: 'points' },
                    { name: 'Quota Points', value: 'quota_points' }
                )
        )
        .addStringOption(option =>
            option
                .setName('dungeon')
                .setDescription('The dungeon to filter by (or "all")')
                .setRequired(true)
                .setAutocomplete(true)
        )
        .addStringOption(option =>
            option
                .setName('since')
                .setDescription('Start date (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss)')
                .setRequired(false)
        )
        .addStringOption(option =>
            option
                .setName('until')
                .setDescription('End date (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss)')
                .setRequired(false)
        )
        .setDMPermission(false),

    async autocomplete(interaction) {
        const focusedValue = interaction.options.getFocused().toLowerCase();
        
        // Always include "all" option at the top
        const choices = [{ name: 'All Dungeons', value: 'all' }];
        
        // Add matching dungeons
        const filtered = DUNGEON_DATA
            .filter(dungeon => 
                dungeon.dungeonName.toLowerCase().includes(focusedValue) ||
                dungeon.codeName.toLowerCase().includes(focusedValue)
            )
            .slice(0, 24) // Leave room for "all" option
            .map(dungeon => ({
                name: dungeon.dungeonName,
                value: dungeon.codeName,
            }));
        
        choices.push(...filtered);
        
        await interaction.respond(choices);
    },

    async run(interaction: ChatInputCommandInteraction) {
        const guild = await ensureGuildContext(interaction);
        if (!guild) return;

        // Get options
        const category = interaction.options.getString('category', true) as 'runs_organized' | 'keys_popped' | 'dungeon_completions' | 'points' | 'quota_points';
        const dungeonKey = interaction.options.getString('dungeon', true);
        const since = interaction.options.getString('since');
        const until = interaction.options.getString('until');

        // Validate date formats if provided
        if (since) {
            const sinceDate = new Date(since);
            if (isNaN(sinceDate.getTime())) {
                await interaction.reply({
                    content: 'Invalid "since" date. Use YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss.',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }
        }

        if (until) {
            const untilDate = new Date(until);
            if (isNaN(untilDate.getTime())) {
                await interaction.reply({
                    content: 'Invalid "until" date. Use YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss.',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }
        }

        // Defer reply (backend call may take a moment)
        await interaction.deferReply();

        try {
            // Fetch leaderboard from backend
            const result = await getLeaderboard(guild.id, category, dungeonKey, since || undefined, until || undefined);

            if (result.leaderboard.length === 0) {
                const dungeonName = dungeonKey === 'all' ? 'any dungeon' : (dungeonByCode[dungeonKey]?.dungeonName || dungeonKey);
                const categoryName = category === 'runs_organized' ? 'runs organized' 
                    : category === 'keys_popped' ? 'keys popped' 
                    : category === 'dungeon_completions' ? 'dungeon completions'
                    : category === 'points' ? 'points'
                    : 'quota points';

                let dateRangeText = '';
                if (since && until) {
                    dateRangeText = ` between **${since}** and **${until}**`;
                } else if (since) {
                    dateRangeText = ` since **${since}**`;
                } else if (until) {
                    dateRangeText = ` until **${until}**`;
                }

                const embed = new EmbedBuilder()
                    .setTitle('Leaderboard')
                    .setDescription(`No data found for **${categoryName}** in **${dungeonName}**${dateRangeText}.`)
                    .setColor(0x95a5a6)
                    .setFooter({ text: `Requested by ${interaction.user.tag}` })
                    .setTimestamp();

                await interaction.editReply({ embeds: [embed] });
                return;
            }

            // Create embeds for pagination (25 entries per page)
            const embeds: EmbedBuilder[] = [];
            const totalEntries = result.leaderboard.length;
            const totalPages = Math.ceil(totalEntries / ENTRIES_PER_PAGE);

            const dungeonName = dungeonKey === 'all' ? 'All Dungeons' : (dungeonByCode[dungeonKey]?.dungeonName || dungeonKey);
            const categoryName = category === 'runs_organized' ? 'Runs Organized' 
                : category === 'keys_popped' ? 'Keys Popped' 
                : category === 'dungeon_completions' ? 'Dungeon Completions'
                : category === 'points' ? 'Points'
                : 'Quota Points';

            const categoryEmoji = category === 'runs_organized' ? '🗺️' 
                : category === 'keys_popped' ? '🔑' 
                : category === 'dungeon_completions' ? '✅'
                : category === 'points' ? '🎯'
                : '⭐';

            // Build date range text for embed description
            let dateRangeText = '';
            if (since && until) {
                dateRangeText = `\n**Date Range:** ${since} to ${until}`;
            } else if (since) {
                dateRangeText = `\n**Since:** ${since}`;
            } else if (until) {
                dateRangeText = `\n**Until:** ${until}`;
            }

            for (let page = 0; page < totalPages; page++) {
                const start = page * ENTRIES_PER_PAGE;
                const end = Math.min(start + ENTRIES_PER_PAGE, totalEntries);
                const pageEntries = result.leaderboard.slice(start, end);

                // Build leaderboard text
                const leaderboardLines = pageEntries.map((entry, index) => {
                    const rank = start + index + 1;
                    const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `**${rank}.**`;
                    return `${medal} <@${entry.user_id}> - **${entry.count}**`;
                });

                const embed = new EmbedBuilder()
                    .setTitle(`${categoryEmoji} ${categoryName} Leaderboard`)
                    .setDescription(
                        `**Dungeon:** ${dungeonName}${dateRangeText}\n\n${leaderboardLines.join('\n')}`
                    )
                    .setColor(0x3498db)
                    .setFooter({ 
                        text: `Page ${page + 1} of ${totalPages} • Total Entries: ${totalEntries} • Requested by ${interaction.user.tag}` 
                    })
                    .setTimestamp();

                embeds.push(embed);
            }

            // Setup pagination if there are multiple pages
            if (embeds.length > 1) {
                await setupLeaderboardPagination(interaction, embeds, interaction.user.id);
            } else {
                // Just send the single embed
                await interaction.editReply({ embeds: [embeds[0]] });
            }

        } catch (err) {
            const errorMessage = formatErrorMessage({
                error: err,
                baseMessage: 'Failed to retrieve leaderboard',
            });
            await interaction.editReply(errorMessage);
        }
    },
};
