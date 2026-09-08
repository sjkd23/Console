import { z } from 'zod';
import { parseColor } from './contract.js';
import { editDraft, type EmbedSession } from './session.js';

/** Shared modal mutations for saved embeds and feature-owned embed templates. */
export function applyEmbedModal(session: EmbedSession, action: string, input: (id: string) => string): void {
    editDraft(session, c => {
        const optional = (id: string) => input(id).trim() ? input(id) : undefined;
        const optionalUrl = (id: string) => optional(id)?.trim();
        switch (action) {
            case 'modal-Title': c.title = optional('title'); break;
            case 'modal-Description': { const value = z.string().max(4000, 'Description editor allows up to 4000 characters.').parse(input('description')); c.description = value.trim() ? value : undefined; break; }
            case 'modal-Color': c.color = parseColor(input('color')); break;
            case 'modal-Title URL': c.url = optionalUrl('url'); break;
            case 'modal-Footer': {
                const text = optional('text'), icon_url = optionalUrl('icon_url');
                if (!text && icon_url) throw new Error('Footer text is required when using a footer icon.');
                c.footer = text ? { text, icon_url } : undefined;
                break;
            }
            case 'modal-Author': {
                const name = optional('name'), icon_url = optionalUrl('icon_url'), url = optionalUrl('url');
                if (!name && (icon_url || url)) throw new Error('Author name is required when using author URLs.');
                c.author = name ? { name, icon_url, url } : undefined;
                break;
            }
            case 'modal-Media': {
                const thumbnail = optionalUrl('thumbnail'), image = optionalUrl('image');
                c.thumbnail = thumbnail ? { url: thumbnail } : undefined;
                c.image = image ? { url: image } : undefined;
                break;
            }
            case 'modal-add-field': c.fields.push({ name: input('name'), value: input('value'), inline: false }); session.selected = c.fields.length - 1; break;
            case 'modal-edit-field': {
                const field = c.fields[session.selected];
                if (!field) throw new Error('Select a field first.');
                field.name = input('name'); field.value = input('value'); break;
            }
            default: throw new Error('Unknown editor. Use the latest builder controls.');
        }
    });
}

export function applyEmbedFieldAction(session: EmbedSession, action: string): void {
    editDraft(session, c => {
        const field = c.fields[session.selected];
        if (!field) throw new Error('Select a field first.');
        if (action === 'remove-field') { c.fields.splice(session.selected, 1); session.selected = Math.max(0, session.selected - 1); }
        else if (action === 'inline') field.inline = !field.inline;
        else {
            const to = session.selected + (action === 'up' ? -1 : 1);
            if (to < 0 || to >= c.fields.length) throw new Error('That field is already at the edge.');
            [c.fields[session.selected], c.fields[to]] = [c.fields[to], field];
            session.selected = to;
        }
    });
}
