// bot/src/commands/logrun.ts
import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    AutocompleteInteraction,
    MessageFlags,
    EmbedBuilder,
} from 'discord.js';
import type { SlashCommand } from '../_types.js';
import { getMemberRoleIds } from '../../lib/permissions/permissions.js';
import { postJSON } from '../../lib/utilities/http.js';
import { dungeonByCode } from '../../constants/dungeons/dungeon-helpers.js';
import { addRecentDungeon } from '../../lib/utilities/dungeon-cache.js';
import { updateQuotaPanelsForUser } from '../../lib/ui/quota-panel.js';
import { ensureGuildContext, fetchGuildMember } from '../../lib/utilities/interaction-helpers.js';
import { formatErrorMessage } from '../../lib/errors/error-handler.js';
import { handleDungeonAutocomplete } from '../../lib/utilities/dungeon-autocomplete.js';
import { formatPoints } from '../../lib/utilities/format-helpers.js';
import { logCommandExecution } from '../../lib/logging/bot-logger.js';
import { validateAndCapAmount, CAPS } from '../../lib/validation/amount-validation.js';

/**
 * /logrun - Manually log run completion quota for organizers.
 * Organizer-only command.
 * This is a fully manual quota logging system that doesn't require an actual run to exist.
 * Supports logging multiple runs at once and negative amounts to remove quota.
 */
export const logrun: SlashCommand = {
    requiredRole: 'organizer',
    data: new SlashCommandBuilder()
        .setName('logrun')
        .setDescription('Manually log run completion quota (Organizer only)')
        .addStringOption(option =>
            option
                .setName('dungeon')
                .setDescription('Choose a dungeon type')
                .setRequired(true)
                .setAutocomplete(true)
        )
        .addIntegerOption(option =>
            option
                .setName('amount')
                .setDescription(`Number of runs to add/remove (max: ${CAPS.RUN_KEY}, negative to remove, default: 1)`)
                .setRequired(false)
        )
        .addUserOption(option =>
            option
                .setName('member')
                .setDescription('Target organizer (defaults to yourself)')
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
        let amount = interaction.options.getInteger('amount') ?? 1;
        const targetUser = interaction.options.getUser('member') ?? interaction.user;

        // Validate and cap amount
        const cappedAmount = validateAndCapAmount(amount, CAPS.RUN_KEY);
        if (cappedAmount === null) {
            await interaction.reply({
                content: '❌ Amount cannot be zero.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        // Notify user if amount was capped
        const wasCapped = cappedAmount !== amount;
        amount = cappedAmount;

        // Validate dungeon
        const dungeon = dungeonByCode[dungeonCode];
        if (!dungeon) {
            await interaction.reply({
                content: '❌ Invalid dungeon selected. Please try again.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        // Fetch target member to ensure they exist in the guild
        const targetMember = await fetchGuildMember(guild, targetUser.id);
        if (!targetMember) {
            await interaction.reply({
                content: `❌ Could not find member ${targetUser.toString()} in this server.`,
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
                total_points: number;
                organizer_id: string;
            }>('/quota/log-run', {
                actorId: interaction.user.id,
                actorRoles,
                guildId: guild.id,
                organizerId: targetUser.id, // Log quota for the target user
                dungeonKey: dungeonCode, // Dungeon type for manual quota logging
                amount,
            });

            // Build success embed
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
                    { name: 'Points Changed', value: `${result.total_points >= 0 ? '+' : ''}${formatPoints(result.total_points)}`, inline: true },
                    { name: 'Organizer', value: `<@${result.organizer_id}>`, inline: true },
                    { name: `${actionText} By`, value: `<@${interaction.user.id}>`, inline: true },
                )
                .setTimestamp();

            // Add warning footer if amount was capped
            if (wasCapped) {
                embed.setFooter({ text: `⚠️ Amount was capped at ${CAPS.RUN_KEY} (max allowed)` });
            }

            await interaction.editReply({
                embeds: [embed],
            });

            // Log to bot-log
            await logCommandExecution(interaction.client, interaction, {
                success: true,
                details: {
                    'Dungeon': dungeon.dungeonName,
                    'Runs': `${amount}`,
                    'Organizer': `<@${result.organizer_id}>`,
                    'Points': formatPoints(result.total_points)
                }
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
            });
            await interaction.editReply(errorMessage);
            await logCommandExecution(interaction.client, interaction, {
                success: false,
                errorMessage: 'Failed to log run quota'
            });
        }
    },

    // Autocomplete handler (same as /run)
    async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
        await handleDungeonAutocomplete(interaction);
    }
};
