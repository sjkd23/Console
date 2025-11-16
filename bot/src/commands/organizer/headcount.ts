// src/commands/headcount.ts
import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    StringSelectMenuBuilder,
    StringSelectMenuInteraction,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    type GuildTextBasedChannel,
    ComponentType
} from 'discord.js';
import type { SlashCommand } from '../_types.js';
import { ensureGuildContext } from '../../lib/utilities/interaction-helpers.js';
import { formatErrorMessage } from '../../lib/errors/error-handler.js';
import { dungeonByCode, searchDungeons } from '../../constants/dungeons/dungeon-helpers.js';
import type { DungeonInfo } from '../../constants/dungeons/dungeon-types.js';
import { getDungeonKeyEmojiIdentifier } from '../../lib/utilities/key-emoji-helpers.js';
import { logRaidCreation } from '../../lib/logging/raid-logger.js';
import { getGuildChannels, getDungeonRolePings } from '../../lib/utilities/http.js';

export const headcount: SlashCommand = {
    requiredRole: 'organizer',
    data: new SlashCommandBuilder()
        .setName('headcount')
        .setDescription('Create a lightweight headcount panel to gauge interest for upcoming runs'),

    async run(interaction: ChatInputCommandInteraction): Promise<void> {
        const guild = await ensureGuildContext(interaction);
        if (!guild) return;

        // Show ephemeral dungeon selection dropdown
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // Get all dungeons for selection (limit to 25 for dropdown)
        const allDungeons = searchDungeons('', 25);

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('headcount:select_dungeons')
            .setPlaceholder('Select dungeons (up to 10)')
            .setMinValues(1)
            .setMaxValues(Math.min(10, allDungeons.length))
            .addOptions(
                allDungeons.map(d => ({
                    label: d.dungeonName,
                    value: d.codeName,
                    description: d.dungeonCategory || undefined
                }))
            );

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

        await interaction.editReply({
            content: '**Select dungeons for the headcount**\n\nChoose up to 10 dungeons:',
            components: [row]
        });

        // Wait for selection
        try {
            const selectInteraction = await interaction.channel!.awaitMessageComponent({
                filter: (i) => i.user.id === interaction.user.id && i.customId === 'headcount:select_dungeons',
                componentType: ComponentType.StringSelect,
                time: 60_000 // 60 second timeout
            }) as StringSelectMenuInteraction;

            await selectInteraction.deferUpdate();

            const selectedCodes = selectInteraction.values;
            const selectedDungeons = selectedCodes
                .map(code => dungeonByCode[code])
                .filter(d => d) as DungeonInfo[];

            if (selectedDungeons.length === 0) {
                await interaction.editReply({
                    content: 'No valid dungeons selected. Please try again.',
                    components: []
                });
                return;
            }

            // Build the headcount panel embed
            const embed = new EmbedBuilder()
                .setTitle('🎯 Headcount')
                .setColor(0x5865F2)
                .setDescription(
                    `Organizer: <@${interaction.user.id}>\n\n` +
                    `**What to do:**\n` +
                    `• Click **Join** if you're interested\n` +
                    `• Click the key buttons if you have keys\n\n` +
                    `**Dungeons:**\n${selectedDungeons.map(d => `• ${d.dungeonName}`).join('\n')}`
                )
                .addFields(
                    { name: 'Participants', value: '0', inline: true },
                    { name: 'Total Keys', value: '0', inline: true }
                )
                .setTimestamp(new Date());

            // Create action buttons
            const joinButton = new ButtonBuilder()
                .setCustomId(`headcount:join:${Date.now()}`)
                .setLabel('Join')
                .setStyle(ButtonStyle.Success);

            const orgButton = new ButtonBuilder()
                .setCustomId(`headcount:org:${Date.now()}`)
                .setLabel('Organizer Panel')
                .setStyle(ButtonStyle.Secondary);

            const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(joinButton, orgButton);

            // Create key buttons (one per dungeon, up to 5 per row)
            const keyButtonRows: ActionRowBuilder<ButtonBuilder>[] = [];
            const keyButtons: ButtonBuilder[] = [];

            for (const dungeon of selectedDungeons) {
                const keyEmojiId = getDungeonKeyEmojiIdentifier(dungeon.codeName);
                
                const keyButton = new ButtonBuilder()
                    .setCustomId(`headcount:key:${Date.now()}:${dungeon.codeName}`)
                    .setLabel(dungeon.dungeonName.length > 15 
                        ? dungeon.dungeonName.substring(0, 13) + '...' 
                        : dungeon.dungeonName)
                    .setStyle(ButtonStyle.Secondary);

                // Add emoji if available
                if (keyEmojiId) {
                    keyButton.setEmoji(keyEmojiId);
                }

                keyButtons.push(keyButton);
            }

            // Split key buttons into rows of up to 5
            for (let i = 0; i < keyButtons.length; i += 5) {
                const rowButtons = keyButtons.slice(i, i + 5);
                keyButtonRows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...rowButtons));
            }

            // Get the configured raid channel
            const { channels } = await getGuildChannels(guild.id);
            const raidChannelId = channels.raid;

            if (!raidChannelId) {
                await interaction.editReply({
                    content: '**Error:** No raid channel is configured. Ask an admin to set one up with `/setchannels`.',
                    components: []
                });
                return;
            }

            // Fetch the raid channel
            let raidChannel: GuildTextBasedChannel;
            try {
                const fetchedChannel = await interaction.client.channels.fetch(raidChannelId);
                if (!fetchedChannel || !fetchedChannel.isTextBased() || fetchedChannel.isDMBased()) {
                    await interaction.editReply({
                        content: '**Error:** The raid channel is invalid. Ask an admin to reconfigure it with `/setchannels`.',
                        components: []
                    });
                    return;
                }
                raidChannel = fetchedChannel as GuildTextBasedChannel;
            } catch (err) {
                console.error('Failed to fetch raid channel:', err);
                await interaction.editReply({
                    content: '**Error:** Can\'t access the raid channel. It may have been deleted. Ask an admin to reconfigure it with `/setchannels`.',
                    components: []
                });
                return;
            }

            // Post headcount panel to raid channel
            // Build content with @here and any configured dungeon role pings
            let content = '@here';
            
            // Check if there are configured role pings for any of the selected dungeons
            try {
                const { dungeon_role_pings } = await getDungeonRolePings(guild.id);
                const rolePings = new Set<string>();
                
                for (const dungeon of selectedDungeons) {
                    const roleId = dungeon_role_pings[dungeon.codeName];
                    if (roleId) {
                        rolePings.add(roleId);
                    }
                }
                
                // Add unique role pings to content
                for (const roleId of rolePings) {
                    content += ` <@&${roleId}>`;
                }
            } catch (e) {
                console.error('Failed to fetch dungeon role pings:', e);
                // Continue without custom role pings
            }
            
            const sent = await raidChannel.send({
                content,
                embeds: [embed],
                components: [buttonRow, ...keyButtonRows]
            });

            // Log the headcount creation to raid-log channel
            const panelTimestamp = Date.now().toString();
            try {
                await logRaidCreation(
                    interaction.client,
                    {
                        guildId: guild.id,
                        organizerId: interaction.user.id,
                        organizerUsername: interaction.user.username,
                        dungeonName: selectedDungeons.map(d => d.dungeonName).join(', '),
                        type: 'headcount',
                        panelTimestamp: sent.id // Use message ID as unique identifier
                    }
                );
            } catch (e) {
                console.error('Failed to log headcount creation to raid-log:', e);
            }

            // Confirm to organizer
            await interaction.editReply({
                content: `✅ Headcount created: ${sent.url}`,
                components: []
            });

        } catch (err) {
            // Timeout or other error
            const errorMessage = formatErrorMessage({
                error: err,
                baseMessage: 'Failed to create headcount panel',
                errorHandlers: {
                    'INTERACTION_COLLECTOR_ERROR': 'Selection timed out. Please run `/headcount` again and select dungeons within 60 seconds.',
                },
            });
            await interaction.editReply({
                content: errorMessage,
                components: []
            });
        }
    }
};
