import { MessageFlags, SlashCommandBuilder, type AutocompleteInteraction } from 'discord.js';
import { z } from 'zod';
import type { SlashCommand } from '../_types.js';
import { embedActor, embedError } from '../../lib/embeds/builder.js';
import { openTicketBuilder } from '../../lib/tickets/builder.js';
import { listConfigs } from '../../lib/tickets/api.js';
import { SnowflakeSchema } from '../../lib/embeds/contract.js';
async function autocomplete(i: AutocompleteInteraction): Promise<void> {
    try { const result = await listConfigs(SnowflakeSchema.parse(i.guildId), await embedActor(i), z.string().max(64).parse(i.options.getFocused()));
        await i.respond(result.configs.map(c => ({ name: `${c.name}${c.enabled ? '' : ' (disabled)'} — ${c.id.slice(0, 8)}`.slice(0, 100), value: c.id }))); }
    catch { await i.respond([]); }
}
export const createticket: SlashCommand = { requiredRole: 'moderator',
    data: new SlashCommandBuilder().setName('createticket').setDescription('Build a ticket type and panel (Moderator+)').setDMPermission(false),
    async run(i) { await openTicketBuilder(i); } };
function command(name: string, deleting: boolean): SlashCommand {
    return { requiredRole: 'moderator', autocomplete,
        data: new SlashCommandBuilder().setName(name).setDescription(deleting ? 'Disable a ticket type; preserve open tickets and history' : 'Edit a ticket type and its panel')
            .setDMPermission(false).addStringOption(o => o.setName('ticket').setDescription('Ticket type').setRequired(true).setAutocomplete(true)),
        async run(i) { await openTicketBuilder(i, i.options.getString('ticket', true), deleting); } };
}
export const editticket = command('editticket', false);
export const deleteticket = command('deleteticket', true);
export const listtickets: SlashCommand = { requiredRole: 'moderator',
    data: new SlashCommandBuilder().setName('listtickets').setDescription('List ticket types in this server (Moderator+)').setDMPermission(false)
        .addIntegerOption(o => o.setName('page').setDescription('Page number').setMinValue(1).setMaxValue(100001)),
    async run(i) {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const page = i.options.getInteger('page') ?? 1;
            const result = await listConfigs(SnowflakeSchema.parse(i.guildId), await embedActor(i), '', page - 1);
            const lines = result.configs.map(c => `${c.name} (${c.id.slice(0, 8)}) — <#${c.panel_channel_id}> / <#${c.category_id}> — ${c.enabled ? 'Active' : 'Disabled'} / ${c.panel_message_id ? 'Published' : 'Unpublished'}`);
            await i.editReply({ content: `**Ticket Types — Page ${page}**\n${lines.slice(0, 8).join('\n') || 'No ticket types on this page.'}`, allowedMentions: { parse: [] } });
            for (let n = 8; n < lines.length; n += 8) await i.followUp({ content: lines.slice(n, n + 8).join('\n'), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
            if (result.has_more) await i.followUp({ content: `Next: /listtickets page:${page + 1}`, flags: MessageFlags.Ephemeral });
        } catch (e) { await i.editReply(embedError(e)); }
    } };
