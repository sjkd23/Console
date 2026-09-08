import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { embedLength, LIMITS } from './contract.js';
import { isDirty, type EmbedSession } from './session.js';
import { renderEmbed } from './render.js';

export const EDITORS = ['Title', 'Description', 'Color', 'Footer', 'Media', 'Author', 'Title URL', 'Timestamp'] as const;
export type Editor = typeof EDITORS[number];
export function customId(s: EmbedSession, action: string): string { return `${s.namespace ?? 'emb'}:${s.id}:${s.revision}:${action}`; }
function buttons(s: EmbedSession, entries: [string, string, boolean?, ButtonStyle?][]) {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(entries.map(([action, label, disabled, style]) =>
        new ButtonBuilder().setCustomId(customId(s, action)).setLabel(label).setStyle(style ?? ButtonStyle.Secondary).setDisabled(disabled ?? false)));
}
export function builderMessage(s: EmbedSession) {
    const selected = s.config.fields[s.selected];
    const components: (ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ChannelSelectMenuBuilder>)[] = [];
    if (s.mode === 'delete') {
        components.push(buttons(s, [['confirm-delete', 'Permanently Delete', false, ButtonStyle.Danger], ['cancel', 'Keep Saved Embed']]));
    } else if (s.mode === 'fields') {
        if (s.config.fields.length) components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder().setCustomId(customId(s, 'select-field')).setPlaceholder('Choose a field to manage').addOptions(
                s.config.fields.map((field, index) => ({ label: `${index + 1}. ${field.name}`.replace(/\s+/g, ' ').slice(0, 100).replace(/[\uD800-\uDBFF]$/, ''), value: String(index), default: index === s.selected }))
            )));
        components.push(buttons(s, [['add-field', 'Add Field', s.config.fields.length >= LIMITS.fields], ['edit-field', 'Edit', !selected], ['remove-field', 'Remove', !selected], ['inline', selected?.inline ? 'Inline: Yes' : 'Inline: No', !selected]]));
        components.push(buttons(s, [['up', 'Move Up', !selected || s.selected === 0], ['down', 'Move Down', !selected || s.selected === s.config.fields.length - 1], ['main', 'Back']]));
    } else {
        components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
            .setCustomId(customId(s, 'editor')).setPlaceholder('Edit an embed property…').addOptions(EDITORS.map(label => ({ label: label === 'Timestamp' ? `Timestamp: ${s.config.timestamp ? 'On' : 'Off'}` : label, value: label })))));
        const moving = Boolean(s.saved?.published_channel_id && s.channelId && s.channelId !== s.saved.published_channel_id);
        components.push(buttons(s, [['fields', 'Fields'], ['save', s.saved ? 'Save Changes' : 'Save', !isDirty(s) && !s.saved?.published_message_id, ButtonStyle.Success], [moving ? 'move' : 'publish', moving ? 'Move Published Embed' : 'Publish', false, ButtonStyle.Primary], ['cancel', 'Cancel', false, ButtonStyle.Danger]]));
        components.push(new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(new ChannelSelectMenuBuilder()
            .setCustomId(customId(s, 'channel')).setPlaceholder('Select a destination channel').setChannelTypes(ChannelType.GuildText)
            .setMinValues(0).setMaxValues(1).setDefaultChannels(s.channelId ? [s.channelId] : [])));
    }
    return {
        content: ['**Embed Builder**', `Name: ${s.saved?.name ?? '(unsaved draft)'}`, `Channel: ${s.channelId ? `<#${s.channelId}>` : 'Not selected'}`,
            `Fields: ${s.config.fields.length}/${LIMITS.fields} • Characters: ${embedLength(s.config)}/${LIMITS.total}`,
            `Status: ${isDirty(s) ? 'Unsaved changes' : 'Saved'}`,
            s.saved?.published_message_id ? `Published: https://discord.com/channels/${s.guildId}/${s.saved.published_channel_id}/${s.saved.published_message_id}` : 'Published: Not tracked',
            s.saved?.published_channel_id && s.channelId !== s.saved.published_channel_id ? 'Save Changes updates the existing post. Move Published Embed explicitly relocates it.' : '',
            s.config.description && s.config.description.length > 4000 ? 'Editing Description replaces this legacy long description with at most 4000 characters.' : '',
            s.mode === 'delete' ? '**Permanently delete this saved embed and its tracked Discord message?**' : 'Blank optional inputs clear properties. Draft expires after 30 minutes of inactivity.', s.notice ?? ''].filter(Boolean).join('\n'),
        embeds: [renderEmbed(s.config)], components, allowedMentions: { parse: [] as [] },
    };
}
type Input = [id: string, label: string, value: string | undefined, max: number, paragraph?: boolean, required?: boolean];
export function editorModal(s: EmbedSession, action: Editor | 'add-field' | 'edit-field' | 'save'): ModalBuilder {
    const c = s.config;
    const field = action === 'edit-field' ? c.fields[s.selected] : undefined;
    const inputs: Input[] = action === 'Title' ? [['title', 'Title', c.title, LIMITS.title]]
        : action === 'Description' ? [['description', 'Description', c.description?.slice(0, 4000), 4000, true]]
        : action === 'Color' ? [['color', 'Hex color (blank clears)', c.color === undefined ? '' : `#${c.color.toString(16).padStart(6, '0')}`, 7]]
        : action === 'Footer' ? [['text', 'Footer text', c.footer?.text, LIMITS.footer, true], ['icon_url', 'Icon URL (optional)', c.footer?.icon_url, 2048]]
        : action === 'Media' ? [['thumbnail', 'Thumbnail URL', c.thumbnail?.url, 2048], ['image', 'Main image URL', c.image?.url, 2048]]
        : action === 'Author' ? [['name', 'Author name', c.author?.name, LIMITS.author], ['icon_url', 'Author icon URL', c.author?.icon_url, 2048], ['url', 'Author URL', c.author?.url, 2048]]
        : action === 'Title URL' ? [['url', 'Title URL', c.url, 2048]]
        : action === 'save' ? [['name', 'Reusable name (letters, numbers, spaces, -)', '', 64, false, true]]
        : [['name', 'Field name', field?.name, LIMITS.fieldName, false, true], ['value', 'Field value', field?.value, LIMITS.fieldValue, true, true]];
    const modal = new ModalBuilder().setCustomId(customId(s, `modal-${action}`)).setTitle(action === 'save' ? 'Save Embed' : `Edit ${action}`);
    for (const [id, label, value, max, paragraph, required] of inputs) {
        const input = new TextInputBuilder().setCustomId(id).setLabel(label).setMaxLength(max)
            .setStyle(paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short).setRequired(required ?? false);
        if (value) input.setValue(value);
        modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    }
    return modal;
}
