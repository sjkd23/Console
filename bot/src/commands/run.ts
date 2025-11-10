import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} from 'discord.js';
import type { SlashCommand } from './_types.js';
import { postJSON } from '../lib/http.js';

export const runCreate: SlashCommand = {
    data: new SlashCommandBuilder()
        .setName('run')
        .setDescription('Create a new run (frontend calls backend).')
        .addStringOption(o =>
            o.setName('dungeon').setDescription('Dungeon name').setRequired(true)
        )
        .addStringOption(o =>
            o.setName('desc').setDescription('Notes/description')
        ),
    async run(interaction: ChatInputCommandInteraction) {
        const dungeon = interaction.options.getString('dungeon', true);
        const desc = interaction.options.getString('desc') || undefined;

        await interaction.deferReply({ ephemeral: true });

        const { runId } = await postJSON<{ runId: number }>('/runs', {
            dungeon,
            desc,
            organizerId: interaction.user.id
        });

        const embed = new EmbedBuilder()
            .setTitle(`🛡️ ${dungeon} Run`)
            .setDescription((desc ?? 'Click to join / choose class. Organizer panel available.'))
            .addFields(
                { name: 'Run ID', value: String(runId), inline: true },
                { name: 'Organizer', value: `${interaction.user.tag}`, inline: true }
            )
            .setTimestamp(new Date());

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

        const message = await interaction.channel?.send({ embeds: [embed], components: [row], content: '@here' });

        await interaction.editReply(
            `Run #${runId} created${message ? ` and posted: ${message.url}` : ''}`
        );
    }
};
