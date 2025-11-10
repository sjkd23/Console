import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import type { SlashCommand } from './_types.js';

export const info: SlashCommand = {
    data: new SlashCommandBuilder()
        .setName('info')
        .setDescription('Shows basic context info (ephemeral).'),
    async run(interaction: ChatInputCommandInteraction) {
        const embed = new EmbedBuilder()
            .setTitle('Bot Info')
            .addFields(
                { name: 'Guild', value: `${interaction.guild?.name} (${interaction.guildId})`, inline: false },
                { name: 'User', value: `${interaction.user.tag} (${interaction.user.id})`, inline: false },
                { name: 'Channel', value: `${interaction.channel?.toString()} (${interaction.channelId})`, inline: false }
            )
            .setTimestamp(new Date());
        await interaction.reply({ embeds: [embed], ephemeral: true });
    }
};
