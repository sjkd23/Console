// bot/src/commands/stats.ts
import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    MessageFlags,
    EmbedBuilder,
} from 'discord.js';
import type { SlashCommand } from './_types.js';
import { getQuotaStats } from '../lib/utilities/http.js';
import { dungeonByCode } from '../constants/dungeons/dungeon-helpers.js';
import { DUNGEON_DATA } from '../constants/dungeons/DungeonData.js';
import { ensureGuildContext } from '../lib/utilities/interaction-helpers.js';
import { formatErrorMessage } from '../lib/errors/error-handler.js';
import { formatPoints } from '../lib/formatting/format-helpers.js';

/**
 * /stats - View quota statistics for yourself or another member.
 * Shows total points, runs organized, verifications, and per-dungeon breakdown.
 * Verified Raider+ command.
 */
export const stats: SlashCommand = {
    requiredRole: 'verified_raider',
    data: new SlashCommandBuilder()
        .setName('stats')
        .setDescription('View quota statistics (Verified Raider+)')
        .addUserOption(option =>
            option
                .setName('member')
                .setDescription('Member to view stats for (defaults to yourself)')
                .setRequired(false)
        ),

    async run(interaction: ChatInputCommandInteraction) {
        const guild = await ensureGuildContext(interaction);
        if (!guild) return;

        // Get target user (defaults to command invoker)
        const targetUser = interaction.options.getUser('member') ?? interaction.user;

        // Defer reply (backend call may take a moment)
        await interaction.deferReply();

        try {
            // Fetch stats from backend
            const stats = await getQuotaStats(guild.id, targetUser.id);

            // Build embed
            const embed = new EmbedBuilder()
                .setTitle(`Quota Stats`)
                .setDescription(`Stats for <@${targetUser.id}>`)
                .setColor(0x3498db);

            // Add Points field (for raider participation - future implementation)
            embed.addFields(
                { name: 'Points', value: `${formatPoints(stats.total_points)}`, inline: true }
            );

            // Add Quota Points field only if they have some (for organizers/verifiers)
            if (stats.total_quota_points > 0) {
                embed.addFields(
                    { name: 'Quota Points', value: `${formatPoints(stats.total_quota_points)}`, inline: true }
                );
            }

            // Add runs organized and verifications
            embed.addFields(
                { name: 'Runs Organized', value: `${stats.total_runs_organized}`, inline: true },
                { name: 'Verifications', value: `${stats.total_verifications}`, inline: true },
                { name: 'Keys Popped', value: `${stats.total_keys_popped}`, inline: true }
            );

            embed.setTimestamp();

            // Create a map of dungeon stats from the backend response
            const dungeonStatsMap = new Map(
                stats.dungeons.map(d => [d.dungeon_key, { 
                    completed: Number(d.completed), 
                    organized: Number(d.organized),
                    keys_popped: Number(d.keys_popped)
                }])
            );

            // Build a list of dungeons with activity
            const dungeonLines: string[] = [];
            
            for (const dungeonInfo of DUNGEON_DATA) {
                const dungeonKey = dungeonInfo.codeName;
                const statsForDungeon = dungeonStatsMap.get(dungeonKey);
                
                // Only show dungeons with activity (non-zero completed, organized, or keys popped)
                if (statsForDungeon && (statsForDungeon.completed > 0 || statsForDungeon.organized > 0 || statsForDungeon.keys_popped > 0)) {
                    dungeonLines.push(
                        `**${dungeonInfo.dungeonName}**: ${statsForDungeon.completed} | ${statsForDungeon.keys_popped} | ${statsForDungeon.organized}`
                    );
                }
            }

            // Add dungeon statistics if there's any activity
            if (dungeonLines.length > 0) {
                // Split into multiple fields if needed (Discord has a 1024 character limit per field)
                const chunkSize = 20; // Show 20 dungeons per field
                for (let i = 0; i < dungeonLines.length; i += chunkSize) {
                    const chunk = dungeonLines.slice(i, i + chunkSize);
                    const fieldName = i === 0 ? 'Dungeons: Completed | Keys | Organized' : 'Dungeons (continued)';
                    
                    embed.addFields({
                        name: fieldName,
                        value: chunk.join('\n'),
                        inline: false
                    });
                }
            } else {
                embed.addFields({
                    name: 'Dungeons: Completed | Keys | Organized',
                    value: 'No activity yet',
                    inline: false
                });
            }

            // Set thumbnail to user avatar
            embed.setThumbnail(targetUser.displayAvatarURL());

            await interaction.editReply({ embeds: [embed] });
        } catch (err) {
            const errorMessage = formatErrorMessage({
                error: err,
                baseMessage: 'Failed to retrieve statistics',
            });
            await interaction.editReply(errorMessage);
        }
    },
};
