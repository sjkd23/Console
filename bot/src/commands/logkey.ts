// bot/src/commands/logkey.ts
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
import { ensureGuildContext, fetchGuildMember } from '../lib/interaction-helpers.js';
import { formatErrorMessage } from '../lib/error-handler.js';
import { handleDungeonAutocomplete } from '../lib/dungeon-autocomplete.js';
import { formatPoints } from '../lib/format-helpers.js';
import { logCommandExecution } from '../lib/bot-logger.js';

/**
 * /logkey - Manually log key pops for raiders.
 * Organizer-only command.
 * Allows organizers to log when a raider popped a key for a dungeon.
 */
export const logkey: SlashCommand = {
    requiredRole: 'organizer',
    data: new SlashCommandBuilder()
        .setName('logkey')
        .setDescription('Log key pops for a raider (Organizer only)')
        .addUserOption(option =>
            option
                .setName('member')
                .setDescription('The member who popped the key')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('dungeon')
                .setDescription('Choose the dungeon the key is for')
                .setRequired(true)
                .setAutocomplete(true)
        )
        .addIntegerOption(option =>
            option
                .setName('amount')
                .setDescription('Number of keys to add/remove (negative to remove, default: 1)')
                .setRequired(false)
                .setMinValue(-100)
                .setMaxValue(100)
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
        const targetUser = interaction.options.getUser('member', true);
        const dungeonCode = interaction.options.getString('dungeon', true);
        const amount = interaction.options.getInteger('amount') ?? 1;

        // Validate amount is not zero
        if (amount === 0) {
            await interaction.reply({
                content: '❌ Amount cannot be zero.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

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
            
            // Call backend to log key pop
            const result = await postJSON<{
                logged: number;
                new_total: number;
                points_awarded: number;
                user_id: string;
            }>('/quota/log-key', {
                actorId: interaction.user.id,
                actorRoles,
                guildId: guild.id,
                userId: targetUser.id,
                dungeonKey: dungeonCode,
                amount,
            });

            // Build success embed
            const isRemoving = amount < 0;
            const actionText = isRemoving ? 'Removed' : 'Logged';
            const embedTitle = isRemoving ? '➖ Key Pops Removed' : '✅ Key Pops Logged';
            const embedColor = isRemoving ? 0xff9900 : 0x00ff00;

            const embed = new EmbedBuilder()
                .setTitle(embedTitle)
                .setColor(embedColor)
                .addFields(
                    { name: 'Dungeon', value: dungeon.dungeonName, inline: true },
                    { name: `Keys ${actionText}`, value: `${Math.abs(amount)}`, inline: true },
                    { name: `${dungeon.dungeonName} Total`, value: `${result.new_total}`, inline: true },
                    { name: 'Raider', value: `<@${result.user_id}>`, inline: true },
                    { name: `${actionText} By`, value: `<@${interaction.user.id}>`, inline: true },
                );

            // Add points awarded field if any points were awarded
            if (result.points_awarded && result.points_awarded > 0) {
                embed.addFields({
                    name: '⭐ Points Awarded',
                    value: `+${formatPoints(result.points_awarded)}`,
                    inline: true
                });
            }

            embed.setTimestamp();

            if (Math.abs(amount) > 1) {
                embed.setFooter({ text: `${actionText} ${Math.abs(amount)} key(s) for ${dungeon.dungeonName}` });
            }

            await interaction.editReply({
                embeds: [embed],
            });

            // Log to bot-log
            await logCommandExecution(interaction.client, interaction, {
                success: true,
                details: {
                    'Dungeon': dungeon.dungeonName,
                    'Keys': `${amount}`,
                    'Raider': `<@${result.user_id}>`,
                    'New Total': `${result.new_total}`
                }
            });

        } catch (err) {
            const errorMessage = formatErrorMessage({
                error: err,
                baseMessage: 'Failed to log key pops',
            });
            await interaction.editReply(errorMessage);
            await logCommandExecution(interaction.client, interaction, {
                success: false,
                errorMessage: 'Failed to log key pops'
            });
        }
    },

    // Autocomplete handler (same as /logrun)
    async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
        await handleDungeonAutocomplete(interaction);
    }
};
