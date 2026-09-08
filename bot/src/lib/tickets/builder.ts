import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, MessageFlags, ModalBuilder, RoleSelectMenuBuilder, TextInputBuilder, TextInputStyle,
    type ButtonInteraction, type ChannelSelectMenuInteraction, type ChatInputCommandInteraction, type ModalSubmitInteraction, type RoleSelectMenuInteraction, type StringSelectMenuInteraction } from 'discord.js';
import { z } from 'zod';
import { embedActor, embedError } from '../embeds/builder.js';
import { EmbedConfigSchema, SnowflakeSchema, embedLength, LIMITS } from '../embeds/contract.js';
import { createSession, sessions as embedSessions, SESSION_TTL, editDraft, type EmbedSession } from '../embeds/session.js';
import { builderMessage, customId, editorModal, EDITORS } from '../embeds/ui.js';
import { applyEmbedFieldAction, applyEmbedModal } from '../embeds/editing.js';
import { renderEmbed } from '../embeds/render.js';
import { ConfigInputSchema, TicketNameSchema, type ConfigInput, type TicketConfig } from './contract.js';
import * as api from './api.js';
import { noMentions, panelDestination, ticketCategory } from './discord.js';
import { disablePanel, publishPanel, savePanel } from './publication.js';

export interface TicketSession extends EmbedSession {
    draft: Partial<ConfigInput> & Pick<ConfigInput, 'panel_embed' | 'opening_embed' | 'staff_role_ids'>;
    ticketConfig?: TicketConfig; view: 'general' | 'panel' | 'opening' | 'delete';
}
export const ticketSessions = new Map<string, TicketSession>();
const timer = setInterval(() => { for (const [id, s] of ticketSessions) if (!s.busy && s.expiresAt < Date.now()) ticketSessions.delete(id); }, 60_000); timer.unref();
type Component = ButtonInteraction | ChannelSelectMenuInteraction | StringSelectMenuInteraction | RoleSelectMenuInteraction | ModalSubmitInteraction;
function buttons(s: TicketSession, items: [string, string, ButtonStyle?, boolean?][]) {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(items.map(([id, label, style, disabled]) => new ButtonBuilder().setCustomId(customId(s, id)).setLabel(label).setStyle(style ?? ButtonStyle.Secondary).setDisabled(disabled ?? false)));
}
export function ticketBuilderMessage(s: TicketSession) {
    const components: (ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<ChannelSelectMenuBuilder> | ActionRowBuilder<RoleSelectMenuBuilder> | ReturnType<typeof builderMessage>['components'][number])[] = [];
    if (s.view === 'delete') components.push(buttons(s, [['delete-confirm', 'Disable Ticket Type', ButtonStyle.Danger], ['cancel', 'Keep Ticket Type']]));
    else if (s.view === 'general') {
        components.push(buttons(s, [['name', 'Ticket Type'], ['panel', 'Edit Panel Embed'], ['opening', 'Edit Opening Embed']]));
        components.push(new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(new ChannelSelectMenuBuilder().setCustomId(customId(s, 'panel-channel')).setPlaceholder('Panel destination channel').setChannelTypes(ChannelType.GuildText).setDefaultChannels(s.draft.panel_channel_id ? [s.draft.panel_channel_id] : [])));
        components.push(new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(new ChannelSelectMenuBuilder().setCustomId(customId(s, 'category')).setPlaceholder('Ticket category').setChannelTypes(ChannelType.GuildCategory).setDefaultChannels(s.draft.category_id ? [s.draft.category_id] : [])));
        components.push(new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder().setCustomId(customId(s, 'roles')).setPlaceholder('Additional ticket staff roles (optional)').setMinValues(0).setMaxValues(20).setDefaultRoles(s.draft.staff_role_ids)));
        components.push(buttons(s, [['save-ticket', s.ticketConfig ? 'Save Changes' : 'Save Ticket Type', ButtonStyle.Success], ['publish-ticket', 'Publish / Move', ButtonStyle.Primary, !s.ticketConfig], ['cancel', 'Cancel']]));
    } else {
        // Reuse saved-embed property selector, field editor, modal IDs and preview renderer.
        components.push(...(s.mode === 'fields' ? builderMessage(s).components : builderMessage(s).components.slice(0, 1)));
        if (s.mode !== 'fields') components.push(buttons(s, [['fields', 'Fields'], ['general', 'Back to Ticket Settings'], [s.view === 'panel' ? 'opening' : 'panel', s.view === 'panel' ? 'Preview Opening Embed' : 'Preview Panel Embed']]));
        components.push(buttons(s, [['preview-only', s.view === 'panel' ? 'Create Ticket' : 'Close Ticket', s.view === 'panel' ? ButtonStyle.Primary : ButtonStyle.Danger, true]]));
    }
    return { content: ['**Ticket Builder**', `Type: ${s.draft.name ?? 'Required — choose Ticket Type'}`, `Panel Channel: ${s.draft.panel_channel_id ? `<#${s.draft.panel_channel_id}>` : 'Required'}`,
        `Ticket Category: ${s.draft.category_id ? `<#${s.draft.category_id}>` : 'Required'}`, `Panel Status: ${s.ticketConfig?.enabled === false ? 'Disabled' : s.ticketConfig?.panel_message_id ? 'Published' : 'Not Published'}`,
        `Editing: ${s.view === 'panel' ? 'Ticket Panel Embed' : s.view === 'opening' ? 'Ticket Opening Embed' : s.view === 'delete' ? 'Disable confirmation — existing tickets stay open' : 'General configuration'}`,
        s.view === 'panel' || s.view === 'opening' ? `Fields: ${s.config.fields.length}/${LIMITS.fields} • Characters: ${embedLength(s.config)}/${LIMITS.total}` : '',
        s.ticketConfig?.panel_message_id ? `Canonical panel: https://discord.com/channels/${s.guildId}/${s.ticketConfig.published_channel_id}/${s.ticketConfig.panel_message_id}` : '',
        'Moderator/admin mappings also receive access. Save first; Publish / Move explicitly publishes or relocates the panel.', s.notice ?? ''].filter(Boolean).join('\n'),
        embeds: [renderEmbed(s.view === 'opening' ? s.draft.opening_embed : s.draft.panel_embed)], components, allowedMentions: noMentions };
}
export async function openTicketBuilder(i: ChatInputCommandInteraction, id?: string, deleting = false): Promise<void> {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    try {
        const actor = await embedActor(i);
        const guildId = SnowflakeSchema.parse(i.guildId);
        const config = id ? await api.getConfig(guildId, actor, id) : undefined;
        if (config && !config.enabled && !deleting) throw new Error('This ticket type is disabled. Create a new type to publish another panel.');
        if (ticketSessions.size >= 1000 || [...ticketSessions.values()].filter(s => s.ownerId === i.user.id).length >= 5) throw new Error('Close an existing ticket builder before opening another.');
        const base = createSession(guildId, i.user.id); embedSessions.delete(base.id);
        const draft = config ? ConfigInputSchema.parse(configInput(config)) : { panel_embed: EmbedConfigSchema.parse({ title: 'Open a Ticket', description: 'Press Create Ticket below.', fields: [] }),
            opening_embed: EmbedConfigSchema.parse({ title: 'Welcome', description: 'Please describe how we can help.', fields: [] }), staff_role_ids: [] };
        const s: TicketSession = { ...base, namespace: 'tkb', draft, ticketConfig: config, config: draft.panel_embed, view: deleting ? 'delete' : 'general' };
        s.messageId = (await i.editReply(ticketBuilderMessage(s))).id; ticketSessions.set(s.id, s);
    } catch (e) { await i.editReply({ content: embedError(e), components: [], embeds: [] }); }
}
function configInput(c: TicketConfig): ConfigInput {
    const { name, panel_channel_id, category_id, panel_embed, opening_embed, staff_role_ids } = c;
    return { name, panel_channel_id, category_id, panel_embed, opening_embed, staff_role_ids };
}
export async function handleTicketBuilder(i: Component): Promise<void> {
    const parsed = z.tuple([z.literal('tkb'), z.string().uuid(), z.coerce.number().int().nonnegative(), z.string()]).safeParse(i.customId.split(':'));
    const s = parsed.success ? ticketSessions.get(parsed.data[1]) : undefined;
    const feedback = async (content: string) => { if (i.deferred || i.replied) await i.followUp({ content, flags: MessageFlags.Ephemeral, allowedMentions: noMentions }); else await i.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: noMentions }); };
    if (!parsed.success || !s || s.expiresAt < Date.now()) { await feedback('This ticket builder expired. Reopen it with /editticket or /createticket.'); return; }
    if (s.ownerId !== i.user.id || s.guildId !== i.guildId || s.messageId !== i.message?.id) { await feedback('This builder belongs to someone else.'); return; }
    if (s.busy) { await feedback('This builder is processing another action.'); return; }
    s.busy = true;
    try {
        const action = parsed.data[3];
        const actor = await embedActor(i);
        if (parsed.data[2] !== s.revision) { await i.deferUpdate(); await i.editReply(ticketBuilderMessage(s)); await feedback('The builder changed. Use its latest controls.'); return; }
        if (!i.guild) throw new Error('Use this in a server.');
        const opensModal = i.isButton() && ['name','add-field','edit-field'].includes(action) || i.isStringSelectMenu() && action === 'editor' && i.values[0] !== 'Timestamp';
        if (opensModal && (i.isButton() || i.isStringSelectMenu())) {
            if (action === 'name') {
                const input = new TextInputBuilder().setCustomId('name').setLabel('Ticket type / purpose').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(64);
                if (s.draft.name) input.setValue(s.draft.name);
                await i.showModal(new ModalBuilder().setCustomId(customId(s, 'modal-name')).setTitle('Ticket Type').addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)));
            } else {
                const editor = i.isStringSelectMenu() ? z.enum(EDITORS).parse(i.values[0]) : z.enum(['add-field','edit-field']).parse(action);
                if (editor === 'add-field' && s.config.fields.length >= 25) throw new Error('This embed already has 25 fields.');
                if (editor === 'edit-field' && !s.config.fields[s.selected]) throw new Error('Select a field first.');
                await i.showModal(editorModal(s, editor));
            }
            return;
        }
        if (i.isModalSubmit() && !i.isFromMessage()) throw new Error('Use the latest builder controls.');
        await i.deferUpdate();
        if (action === 'cancel') { ticketSessions.delete(s.id); await i.editReply({ content: 'Ticket builder closed.', embeds: [], components: [] }); return; }
        if (s.view === 'delete') {
            if (action !== 'delete-confirm' || !s.ticketConfig) throw new Error('Use the confirmation controls.');
            const result = await disablePanel(i.guild, actor, s.ticketConfig); s.ticketConfig = result.config; s.notice = result.notice;
            s.revision++; await i.editReply(ticketBuilderMessage(s)); return;
        }
        const next = structuredClone(s); next.notice = undefined;
        if (i.isModalSubmit()) {
            const input = (id: string) => z.string().parse(i.fields.getTextInputValue(id));
            if (action === 'modal-name') next.draft.name = TicketNameSchema.parse(input('name'));
            else applyEmbedModal(next, action, input);
        } else if (i.isChannelSelectMenu()) {
            const id = z.array(SnowflakeSchema).length(1).parse(i.values)[0];
            if (action === 'panel-channel') { await panelDestination(i.guild, id); next.draft.panel_channel_id = id; }
            else if (action === 'category') { await ticketCategory(i.guild, id); next.draft.category_id = id; }
        } else if (i.isRoleSelectMenu() && action === 'roles') {
            const ids = z.array(SnowflakeSchema).max(20).parse(i.values);
            for (const id of ids) { const role = await i.guild.roles.fetch(id); if (!role || role.guild.id !== i.guildId || id === i.guildId) throw new Error('Select valid staff roles, excluding @everyone.'); }
            next.draft.staff_role_ids = ids;
        } else if (i.isStringSelectMenu()) {
            if (action === 'select-field') next.selected = z.coerce.number().int().min(0).max(next.config.fields.length - 1).parse(i.values[0]);
            else if (action === 'editor' && i.values[0] === 'Timestamp') editDraft(next, c => { c.timestamp = c.timestamp ? undefined : new Date().toISOString(); });
        } else if (i.isButton()) {
            if (['remove-field','inline','up','down'].includes(action)) applyEmbedFieldAction(next, action);
            else if (action === 'fields' || action === 'main') next.mode = action;
            else if (action === 'panel' || action === 'opening' || action === 'general') {
                next.view = action; next.mode = 'main'; next.selected = 0;
                next.config = structuredClone(action === 'opening' ? next.draft.opening_embed : next.draft.panel_embed);
            } else if (action === 'save-ticket') {
                const input = ConfigInputSchema.parse(next.draft);
                const result = await savePanel(i.guild, actor, input, next.ticketConfig);
                next.ticketConfig = s.ticketConfig = result.config; next.notice = s.notice = result.notice;
            } else if (action === 'publish-ticket') {
                if (!next.ticketConfig || JSON.stringify(ConfigInputSchema.parse(next.draft)) !== JSON.stringify(configInput(next.ticketConfig))) throw new Error('Save Changes before publishing or moving this panel.');
                const result = await publishPanel(i.guild, actor, next.ticketConfig);
                next.ticketConfig = s.ticketConfig = result.config; next.notice = s.notice = result.notice;
            } else throw new Error('Use the latest builder controls.');
        }
        if (next.view === 'panel') next.draft.panel_embed = EmbedConfigSchema.parse(next.config);
        if (next.view === 'opening') next.draft.opening_embed = EmbedConfigSchema.parse(next.config);
        next.revision++; next.expiresAt = Date.now() + SESSION_TTL;
        Object.assign(s, next); await i.editReply(ticketBuilderMessage(s));
    } catch (e) { await feedback(embedError(e)); } finally { s.busy = false; }
}
