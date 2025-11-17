import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    EmbedBuilder,
} from 'discord.js';
import type { SlashCommand } from './_types.js';
import { logCommandExecution } from '../lib/logging/bot-logger.js';

/**
 * /ping - Check the bot's latency and response time
 * Verified Raider+ command
 */
export const ping: SlashCommand = {
    requiredRole: 'verified_raider',
    data: new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Check the bot\'s latency and response time (Verified Raider+)'),

    async run(interaction: ChatInputCommandInteraction) {
        // Get the timestamp when the command was created
        const sent = Date.now();

        // Reply to the interaction first
        await interaction.reply({ 
            content: 'Pinging...', 
            fetchReply: true 
        });

        // Calculate latencies
        const roundTripLatency = Date.now() - sent;
        const websocketLatency = interaction.client.ws.ping;

        // Create an embed with the latency information
        const embed = new EmbedBuilder()
            .setTitle('Pong!')
            .setColor(websocketLatency < 200 ? 0x57F287 : websocketLatency < 400 ? 0xFEE75C : 0xED4245)
            .addFields(
                {
                    name: 'Roundtrip Latency',
                    value: `${roundTripLatency}ms`,
                    inline: true
                },
                {
                    name: 'WebSocket Latency',
                    value: `${websocketLatency}ms`,
                    inline: true
                }
            )
            .setTimestamp()
            .setFooter({ text: 'Bot Status' });

        // Edit the original reply with the embed
        await interaction.editReply({
            content: '',
            embeds: [embed]
        });

        // Log to bot-log
        await logCommandExecution(interaction.client, interaction, {
            success: true,
            details: {
                'Roundtrip Latency': `${roundTripLatency}ms`,
                'WebSocket Latency': `${websocketLatency}ms`,
            }
        });
    },
};
