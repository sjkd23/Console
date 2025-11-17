// bot/src/commands/conifgs/sendrolepingembed.ts
import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    EmbedBuilder,
    MessageFlags,
    PermissionFlagsBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
} from 'discord.js';
import type { SlashCommand } from '../_types.js';
import { getGuildChannels, getDungeonRolePings, BackendError } from '../../lib/utilities/http.js';
import { logCommandExecution } from '../../lib/logging/bot-logger.js';
import { DUNGEON_DATA } from '../../constants/dungeons/DungeonData.js';

/**
 * /sendrolepingembed - Send the role ping panel to the configured role-ping channel (Administrator only)
 */
export const sendrolepingembed: SlashCommand = {
    requiredRole: undefined, // Uses Discord Administrator permission instead
    data: new SlashCommandBuilder()
        .setName('sendrolepingembed')
        .setDescription('Send the role ping panel to the role-ping channel (Administrator)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
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

            // 2) Check Discord Administrator permission
            if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
                await interaction.reply({
                    content: '❌ **Access Denied**\n\nYou must have Discord **Administrator** permission to send the role ping panel.',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            // 3) Defer reply
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            // 4) Get the role-ping channel
            const { channels } = await getGuildChannels(interaction.guildId!);
            const rolePingChannelId = channels.role_ping;

            if (!rolePingChannelId) {
                await interaction.editReply(
                    '❌ **No Role Ping Channel Configured**\n\n' +
                    'Please configure a role-ping channel first using `/setchannels role_ping:#channel`.'
                );
                return;
            }

            // 5) Fetch the channel
            const channel = await interaction.client.channels.fetch(rolePingChannelId).catch(() => null);
            if (!channel || channel.type !== ChannelType.GuildText) {
                await interaction.editReply(
                    '❌ **Invalid Role Ping Channel**\n\n' +
                    'The configured role-ping channel is invalid or inaccessible. ' +
                    'Please reconfigure it using `/setchannels role_ping:#channel`.'
                );
                return;
            }

            // 6) Get dungeon role pings
            const { dungeon_role_pings } = await getDungeonRolePings(interaction.guildId!);

            // 7) Build the embed
            const embed = new EmbedBuilder()
                .setTitle('🔔 Dungeon Role Ping Panel')
                .setDescription(
                    'Click the buttons below to toggle dungeon ping roles. ' +
                    'You will be pinged when raids for these dungeons are created.\n\n' +
                    '**Available Role Pings:**'
                )
                .setColor(0x5865F2) // Discord blurple
                .setTimestamp();

            // Add all configured role pings to the embed
            if (Object.keys(dungeon_role_pings).length === 0) {
                embed.addFields({
                    name: 'No Role Pings Configured',
                    value: 'Administrators need to configure role pings using `/configrolepings` first.',
                });
            } else {
                // Sort dungeons by name
                const sortedDungeons = Object.entries(dungeon_role_pings)
                    .map(([dungeonKey, roleId]) => {
                        const dungeon = DUNGEON_DATA.find(d => d.codeName === dungeonKey);
                        return {
                            dungeonKey,
                            roleId,
                            dungeonName: dungeon?.dungeonName || dungeonKey,
                        };
                    })
                    .sort((a, b) => a.dungeonName.localeCompare(b.dungeonName));

                for (const { dungeonName, roleId } of sortedDungeons) {
                    embed.addFields({
                        name: dungeonName,
                        value: `<@&${roleId}>`,
                        inline: true,
                    });
                }
            }

            // 8) Build the buttons (max 5 per row, max 25 total)
            const buttons: ActionRowBuilder<ButtonBuilder>[] = [];
            const dungeonEntries = Object.entries(dungeon_role_pings);

            // Sort by dungeon name for consistent button ordering
            const sortedEntries = dungeonEntries
                .map(([dungeonKey, roleId]) => {
                    const dungeon = DUNGEON_DATA.find(d => d.codeName === dungeonKey);
                    return {
                        dungeonKey,
                        roleId,
                        dungeonName: dungeon?.dungeonName || dungeonKey,
                        portalEmojiId: dungeon?.portalEmojiId,
                    };
                })
                .sort((a, b) => a.dungeonName.localeCompare(b.dungeonName));

            // Create buttons for each dungeon (up to 20 dungeons = 4 rows of 5)
            for (let i = 0; i < sortedEntries.length && i < 20; i += 5) {
                const row = new ActionRowBuilder<ButtonBuilder>();
                
                for (let j = i; j < Math.min(i + 5, sortedEntries.length) && j < 20; j++) {
                    const { dungeonKey, portalEmojiId } = sortedEntries[j];
                    
                    const button = new ButtonBuilder()
                        .setCustomId(`roleping:toggle:${dungeonKey}`)
                        .setStyle(ButtonStyle.Secondary);

                    if (portalEmojiId) {
                        button.setEmoji(portalEmojiId);
                    } else {
                        button.setLabel(sortedEntries[j].dungeonName.substring(0, 80)); // Discord label max length
                    }

                    row.addComponents(button);
                }
                
                buttons.push(row);
            }

            // Add "Add All" and "Remove All" buttons in the last row
            const controlRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId('roleping:addall')
                    .setLabel('Add All Roles')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('roleping:removeall')
                    .setLabel('Remove All Roles')
                    .setStyle(ButtonStyle.Danger)
            );
            buttons.push(controlRow);

            // 9) Send the panel to the role-ping channel
            await channel.send({
                embeds: [embed],
                components: buttons,
            });

            // 10) Confirm to the administrator
            await interaction.editReply(
                `✅ **Role Ping Panel Sent**\n\nThe panel has been sent to <#${rolePingChannelId}>.`
            );

            await logCommandExecution(interaction.client, interaction, { success: true });
        } catch (err) {
            console.error('sendrolepingembed command error:', err);

            let errorMsg = '❌ Failed to send role ping panel. Please try again later.';
            if (err instanceof BackendError) {
                errorMsg = `❌ Error: ${err.message}`;
            }

            try {
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply(errorMsg);
                } else {
                    await interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral });
                }
            } catch { }

            await logCommandExecution(interaction.client, interaction, {
                success: false,
                errorMessage: errorMsg
            });
        }
    },
};
