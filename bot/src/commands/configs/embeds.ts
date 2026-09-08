import { MessageFlags, SlashCommandBuilder, type AutocompleteInteraction, type ChatInputCommandInteraction } from 'discord.js';
import { z } from 'zod';
import type { SlashCommand } from '../_types.js';
import { embedActor, embedError, openBuilder } from '../../lib/embeds/builder.js';
import { listSavedEmbeds } from '../../lib/embeds/api.js';
import { SnowflakeSchema } from '../../lib/embeds/contract.js';

async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    try {
        const actor = await embedActor(interaction);
        const result = await listSavedEmbeds(SnowflakeSchema.parse(interaction.guildId), actor, z.string().max(64).parse(interaction.options.getFocused()));
        await interaction.respond(result.embeds.map(embed => ({ name: embed.name, value: embed.id })));
    } catch { await interaction.respond([]); }
}
function savedCommand(name: string, description: string, deleting = false): SlashCommand {
    return {
        requiredRole: 'moderator', autocomplete,
        data: new SlashCommandBuilder().setName(name).setDescription(description).setDMPermission(false)
            .addStringOption(option => option.setName('embed').setDescription('Saved embed in this server').setRequired(true).setAutocomplete(true)),
        async run(interaction) { await openBuilder(interaction, interaction.options.getString('embed', true), deleting); },
    };
}
export const createembed: SlashCommand = {
    requiredRole: 'moderator',
    data: new SlashCommandBuilder().setName('createembed').setDescription('Build, preview and save an embed (Moderator+)').setDMPermission(false),
    async run(interaction) { await openBuilder(interaction); },
};
export const editembed = savedCommand('editembed', 'Open a saved embed to edit or publish (Moderator+)');
export const deleteembed = savedCommand('deleteembed', 'Review and confirm deletion of a saved embed (Moderator+)', true);
export const listembeds: SlashCommand = {
    requiredRole: 'moderator',
    data: new SlashCommandBuilder().setName('listembeds').setDescription('List saved embeds in this server (Moderator+)').setDMPermission(false)
        .addIntegerOption(option => option.setName('page').setDescription('Page number (25 per page)').setMinValue(1).setMaxValue(100001)),
    async run(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const actor = await embedActor(interaction);
            const page = z.number().int().min(1).max(100001).parse(interaction.options.getInteger('page') ?? 1);
            const result = await listSavedEmbeds(SnowflakeSchema.parse(interaction.guildId), actor, '', page - 1);
            // Names are bounded to 64 ASCII characters. Split pages into up to two content messages to stay below 2000.
            const lines = result.embeds.map(embed => `• ${embed.name} — <t:${Math.floor(Date.parse(embed.updated_at) / 1000)}:R>`);
            const heading = `**Saved Embeds — Page ${page}**\n`;
            const content = heading + (lines.slice(0, 15).join('\n') || 'No saved embeds on this page.');
            await interaction.editReply({ content, allowedMentions: { parse: [] } });
            if (lines.length > 15) await interaction.followUp({ content: lines.slice(15).join('\n'), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
            if (result.has_more) await interaction.followUp({ content: `More embeds: /listembeds page:${page + 1}`, flags: MessageFlags.Ephemeral });
        } catch (error) { await interaction.editReply(embedError(error)); }
    },
};
