// src/commands/run.ts
import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    AutocompleteInteraction,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    type GuildTextBasedChannel
} from 'discord.js';
import type { SlashCommand } from './_types.js';
import { postJSON } from '../lib/http.js';
import { dungeonByCode, searchDungeons } from '../constants/dungeon-helpers.js';

export const runCreate: SlashCommand = {
    data: new SlashCommandBuilder()
        .setName('run')
        .setDescription('Create a new run (posts to this channel).')
        .addStringOption(o =>
            o.setName('dungeon')
                .setDescription('Choose a dungeon')
                .setRequired(true)
                .setAutocomplete(true)
        )
        .addStringOption(o =>
            o.setName('party').setDescription('Party name (optional)')
        )
        .addStringOption(o =>
            o.setName('location').setDescription('Location/server (optional)')
        ),

    // Slash action
    async run(interaction: ChatInputCommandInteraction): Promise<void> {
        const codeName = interaction.options.getString('dungeon', true);
        const d = dungeonByCode[codeName];

        if (!d) {
            await interaction.reply({
                content: 'Unknown dungeon name. Try again.',
                ephemeral: true
            });
            return;
        }

        const desc = interaction.options.getString('desc') || undefined;
        const party = interaction.options.getString('party') || undefined;
        const location = interaction.options.getString('location') || undefined;

        await interaction.deferReply({ ephemeral: true });

        // Create DB run
        const { runId } = await postJSON<{ runId: number }>('/runs', {
            guildId: interaction.guildId!,
            guildName: interaction.guild?.name ?? 'unknown',
            organizerId: interaction.user.id,
            organizerUsername: interaction.user.username,
            channelId: interaction.channelId!,
            dungeonKey: d.codeName,      // stable key in DB
            dungeonLabel: d.dungeonName, // human label in DB
            description: desc
        });

        // Build the public embed (new layout)
        const embed = new EmbedBuilder()
            .setTitle(`${d.dungeonName}`)
            .setDescription(
                desc ?? `Organizer: <@${interaction.user.id}>`
            )
            .addFields(
                { name: 'Raiders', value: '0', inline: false }
            )
            .setTimestamp(new Date());

        // Color & thumbnail if present
        if (d.dungeonColors?.length) embed.setColor(d.dungeonColors[0]);
        if (d.portalLink?.url) embed.setThumbnail(d.portalLink.url);

        // Public buttons + organizer panel opener
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`run:join:${runId}`)
                .setLabel('Join')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`run:class:${runId}`)
                .setLabel('Class')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`run:org:${runId}`)
                .setLabel('Organizer Panel')
                .setStyle(ButtonStyle.Secondary)
        );

        // Must be in a guild text channel to send a public message
        if (!interaction.inGuild() || !interaction.channel) {
            await interaction.editReply(
                'This command can only be used in a server text channel.'
            );
            return;
        }

        const channel = interaction.channel as GuildTextBasedChannel;

        let message = '@here'
        if (party) {
            message += ` *Party:* **${party}**`;
        } if (location) {
            message += ` | *Location:* **${location}**`;
        }
        const sent = await channel.send({
            content: message,
            embeds: [embed],
            components: [row]
        });

        await interaction.editReply(
            `Run created${sent ? ` and posted: ${sent.url}` : ''}`
        );
    },

    // Autocomplete handler
    async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
        const focused = interaction.options.getFocused(true);
        if (focused.name !== 'dungeon') {
            await interaction.respond([]);
            return;
        }

        const results = searchDungeons(focused.value ?? '', 25).map(d => ({
            name: d.dungeonName,   // visible
            value: d.codeName      // sent back to command
        }));

        await interaction.respond(results);
    }
};
