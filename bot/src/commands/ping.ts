import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import type { SlashCommand } from './_types.js';

export const ping: SlashCommand = {
    data: new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Replies with pong and latency.'),
    async run(interaction: ChatInputCommandInteraction) {
        const sent = Date.now();
        await interaction.reply({ content: 'Pong!', ephemeral: true });
        const latency = Date.now() - sent;
        await interaction.followUp({ content: `Latency: ~${latency} ms`, ephemeral: true });
    }
};
