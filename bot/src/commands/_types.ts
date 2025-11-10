import type { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';

export type SlashCommand = {
    data: SlashCommandBuilder;
    run: (interaction: ChatInputCommandInteraction) => Promise<void>;
};
