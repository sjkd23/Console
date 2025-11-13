// bot/src/commands/conifgs/configverification.ts
import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    EmbedBuilder,
    MessageFlags,
    GuildMember,
    ChannelType,
    TextChannel,
} from 'discord.js';
import type { SlashCommand } from '../_types.js';
import { getGuildChannels, BackendError } from '../../lib/http.js';
import { hasInternalRole, getMemberRoleIds } from '../../lib/permissions/permissions.js';
import {
    createVerificationPanelEmbed,
    createVerificationPanelButton,
} from '../../lib/verification.js';

export const configverification: SlashCommand = {
    requiredRole: 'moderator',
    data: new SlashCommandBuilder()
        .setName('configverification')
        .setDescription('Manage RealmEye verification system (Moderator+)')
        .setDMPermission(false),

    async run(interaction: ChatInputCommandInteraction): Promise<void> {
        try {
            // 1) Guild-only check
            if (!interaction.inGuild() || !interaction.guild) {
                await interaction.reply({
                    content: 'This command can only be used in a server.',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            // 2) Defer early
            await interaction.deferReply({ ephemeral: true });

            // 3) Fetch member
            let member: GuildMember;
            try {
                member = await interaction.guild.members.fetch(interaction.user.id);
            } catch {
                await interaction.editReply('❌ Could not fetch your member record. Try again in a moment.');
                return;
            }

            const subcommand = interaction.options.getSubcommand();

            if (subcommand === 'send-panel') {
                await handleSendPanel(interaction, member);
            }
        } catch (unhandled) {
            console.error('[configverification] Unhandled error:', unhandled);
            try {
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply('❌ Something went wrong while handling this command.');
                } else {
                    await interaction.reply({ content: '❌ Something went wrong.', ephemeral: true });
                }
            } catch { }
        }
    },
};

async function handleSendPanel(
    interaction: ChatInputCommandInteraction,
    member: GuildMember
): Promise<void> {
    const guild = interaction.guild!;

    // Get target channel (from option or config)
    let targetChannel: TextChannel | null = null;
    const channelOption = interaction.options.getChannel('channel');

    if (channelOption) {
        // Use specified channel
        if (channelOption.type !== ChannelType.GuildText) {
            await interaction.editReply('❌ The specified channel must be a text channel.');
            return;
        }
        targetChannel = channelOption as TextChannel;
    } else {
        // Use configured get-verified channel
        try {
            const { channels } = await getGuildChannels(guild.id);
            const getverifiedChannelId = channels.getverified;

            if (!getverifiedChannelId) {
                await interaction.editReply(
                    '❌ **Get-Verified channel not configured**\n\n' +
                    'Please configure the get-verified channel first using `/setchannels getverified:#channel`.\n' +
                    'Alternatively, you can specify a channel using the `channel` option.'
                );
                return;
            }

            const channel = await guild.channels.fetch(getverifiedChannelId);
            if (!channel || channel.type !== ChannelType.GuildText) {
                await interaction.editReply(
                    '❌ **Configured get-verified channel not found or invalid**\n\n' +
                    'The configured channel may have been deleted. Please reconfigure it using `/setchannels`.'
                );
                return;
            }

            targetChannel = channel as TextChannel;
        } catch (err) {
            console.error('[configverification] Error fetching channel config:', err);
            await interaction.editReply(
                '❌ Failed to load channel configuration. Please try again later.'
            );
            return;
        }
    }

    // Check bot permissions in target channel
    const botMember = await guild.members.fetchMe();
    const permissions = targetChannel.permissionsFor(botMember);

    if (!permissions || !permissions.has(['SendMessages', 'EmbedLinks'])) {
        await interaction.editReply(
            `❌ **Missing Permissions**\n\n` +
            `The bot lacks permission to send messages or embed links in ${targetChannel}.\n` +
            `Please grant the bot these permissions and try again.`
        );
        return;
    }

    // Send verification panel
    try {
        const embed = createVerificationPanelEmbed();
        const button = createVerificationPanelButton();

        const message = await targetChannel.send({
            embeds: [embed],
            components: [button],
        });

        // Success response
        await interaction.editReply(
            `✅ **Verification panel sent!**\n\n` +
            `The verification panel has been posted in ${targetChannel}.\n` +
            `Users can now click the "Get Verified" button to start the verification process.\n\n` +
            `[Jump to message](${message.url})`
        );
    } catch (err) {
        console.error('[configverification] Error sending panel:', err);
        await interaction.editReply(
            '❌ Failed to send verification panel. Please check bot permissions and try again.'
        );
    }
}
