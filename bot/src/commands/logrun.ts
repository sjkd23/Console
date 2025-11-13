// bot/src/commands/logrun.ts
import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    AutocompleteInteraction,
    MessageFlags,
    EmbedBuilder,
} from 'discord.js';
import type { SlashCommand } from './_types.js';
import { getMemberRoleIds } from '../lib/permissions/permissions.js';
import { postJSON } from '../lib/http.js';
import { dungeonByCode } from '../constants/dungeon-helpers.js';
import { addRecentDungeon } from '../lib/dungeon-cache.js';
import { updateQuotaPanelsForUser } from '../lib/quota-panel.js';
import { ensureGuildContext, fetchGuildMember } from '../lib/interaction-helpers.js';
import { formatErrorMessage } from '../lib/error-handler.js';
import { handleDungeonAutocomplete } from '../lib/dungeon-autocomplete.js';

/**
 * /logrun - Manually log run completion quota for organizers.
 * Organizer-only command.
 * Supports logging multiple runs at once if an organizer completed multiple dungeons.
 * Idempotent: will not double-count the same run_id.
 */
export const logrun: SlashCommand = {
    requiredRole: 'organizer',
    data: new SlashCommandBuilder()
        .setName('logrun')
        .setDescription('Manually log run completion quota (Organizer only)')
        .addStringOption(option =>
            option
                .setName('dungeon')
                .setDescription('Choose a dungeon to log')
                .setRequired(true)
                .setAutocomplete(true)
        )
        .addIntegerOption(option =>
            option
                .setName('amount')
                .setDescription('Number of runs to add/remove (negative to remove, default: 1)')
                .setRequired(false)
        ),

    async run(interaction: ChatInputCommandInteraction) {
        const guild = await ensureGuildContext(interaction);
        if (!guild) return;

        // Fetch invoker member (permission check done by middleware)
        const invokerMember = await fetchGuildMember(guild, interaction.user.id);
        if (!invokerMember) {
            await interaction.reply({
                content: 'Could not fetch your member information.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        // Get options
        const dungeonCode = interaction.options.getString('dungeon', true);
        const amount = interaction.options.getInteger('amount') ?? 1;

        // Validate dungeon
        const dungeon = dungeonByCode[dungeonCode];
        if (!dungeon) {
            await interaction.reply({
                content: '❌ Invalid dungeon selected. Please try again.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        // Defer reply (backend call may take a moment)
        await interaction.deferReply();

        try {
            // Track this dungeon as recently used for this guild
            addRecentDungeon(guild.id, dungeonCode);

            // Get actor's role IDs for authorization
            const actorRoles = getMemberRoleIds(invokerMember);
            
            // Call backend to log run quota (pass dungeonKey to find most recent run)
            const result = await postJSON<{
                logged: number;
                already_logged: boolean;
                total_points: number;
                organizer_id: string;
            }>('/quota/log-run', {
                actorId: interaction.user.id,
                actorRoles,
                guildId: guild.id,
                dungeonKey: dungeonCode, // Backend will find most recent run
                amount,
            });

            // Build success embed
            if (result.already_logged) {
                // Run was already logged (shouldn't happen anymore, but keep for safety)
                await interaction.editReply({
                    content: `⚠️ **Already Logged**\n\nYour most recent **${dungeon.dungeonName}** run has already been logged for quota.\n\nNo points were added to prevent double-counting.`,
                });
                return;
            }

            const isRemoving = amount < 0;
            const actionText = isRemoving ? 'Removed' : 'Logged';
            const embedTitle = isRemoving ? '➖ Run Quota Removed' : '✅ Run Quota Logged';
            const embedColor = isRemoving ? 0xff9900 : 0x00ff00;

            const embed = new EmbedBuilder()
                .setTitle(embedTitle)
                .setColor(embedColor)
                .addFields(
                    { name: 'Dungeon', value: dungeon.dungeonName, inline: true },
                    { name: `Runs ${actionText}`, value: `${Math.abs(amount)}`, inline: true },
                    { name: 'Points Changed', value: `${result.total_points > 0 ? '+' : ''}${result.total_points}`, inline: true },
                    { name: 'Organizer', value: `<@${result.organizer_id}>`, inline: true },
                    { name: `${actionText} By`, value: `<@${interaction.user.id}>`, inline: true },
                )
                .setTimestamp();

            if (Math.abs(amount) > 1) {
                embed.setFooter({ text: `${actionText} ${result.logged} run completion(s)` });
            }

            await interaction.editReply({
                embeds: [embed],
            });

            // Auto-update quota panels for this user's roles
            // Run asynchronously to not block the response
            console.log(`[Logrun] Triggering auto-update for user ${result.organizer_id} in guild ${guild.id}`);
            updateQuotaPanelsForUser(
                interaction.client,
                guild.id,
                result.organizer_id
            ).then(() => {
                console.log(`[Logrun] Successfully triggered quota panel auto-update`);
            }).catch(err => {
                console.error('[Logrun] Failed to auto-update quota panels:', err);
            });
        } catch (err) {
            const errorMessage = formatErrorMessage({
                error: err,
                baseMessage: 'Failed to log run quota',
                errorHandlers: {
                    'RUN_NOT_FOUND': `**Issue:** The selected **${dungeon.dungeonName}** run was not found.\n\n**What to do:**\n• Try selecting a different dungeon\n• Create a new run with \`/run\` first`,
                },
            });
            await interaction.editReply(errorMessage);
        }
    },

    // Autocomplete handler (same as /run)
    async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
        await handleDungeonAutocomplete(interaction);
    }
};
