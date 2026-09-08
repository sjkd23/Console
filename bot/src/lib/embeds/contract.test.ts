import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { EmbedBuilder } from 'discord.js';
import { EmbedConfigSchema, EmbedNameSchema, parseColor, type EmbedConfig } from './contract.js';
import { createSession, editDraft, expireSessions, isDirty, sessions, SESSION_TTL } from './session.js';
import { renderEmbed } from './render.js';
import { builderMessage, editorModal, EDITORS } from './ui.js';

describe('embed validation and rendering contract', () => {
    it('keeps bot and backend validation identical', () => {
        assert.equal(readFileSync(new URL('./contract.ts', import.meta.url), 'utf8'), readFileSync(new URL('../../../../backend/src/lib/embeds/contract.ts', import.meta.url), 'utf8'));
    });
    const valid = { description: 'Body', fields: [] };
    for (const [label, patch] of [
        ['title', { title: 'x'.repeat(257) }], ['description', { description: 'x'.repeat(4097) }],
        ['footer', { footer: { text: 'x'.repeat(2049) } }], ['author', { author: { name: 'x'.repeat(257) } }],
        ['field name', { fields: [{ name: 'x'.repeat(257), value: 'y' }] }], ['field value', { fields: [{ name: 'x', value: 'y'.repeat(1025) }] }],
        ['empty field name', { fields: [{ name: '', value: 'x' }] }], ['blank field value', { fields: [{ name: 'x', value: '  ' }] }],
        ['field count', { fields: Array.from({ length: 26 }, () => ({ name: 'n', value: 'v' })) }],
        ['aggregate', { description: 'x'.repeat(4000), footer: { text: 'x'.repeat(2001) } }],
        ['color', { color: 0x1000000 }], ['malformed URL', { image: { url: 'nope' } }], ['non-http URL', { url: 'javascript:alert(1)' }],
        ['credentials', { url: 'https://user:pass@example.com' }], ['unknown properties', { destination: '123' }],
    ] as const) it(`rejects invalid ${label}`, () => assert.equal(EmbedConfigSchema.safeParse({ ...valid, ...patch }).success, false));
    it('rejects empty and decoration-only embeds', () => {
        for (const value of [{}, { color: 123 }, { timestamp: new Date().toISOString() }, { url: 'https://example.com' }]) assert.equal(EmbedConfigSchema.safeParse(value).success, false);
    });
    it('accepts boundary lengths and renders the same API object as Discord.js', () => {
        const config = EmbedConfigSchema.parse({ title: 't'.repeat(256), description: 'd'.repeat(4096), fields: [{ name: 'n'.repeat(256), value: 'v'.repeat(1024), inline: true }], footer: { text: 'f'.repeat(368) } });
        assert.equal(EmbedConfigSchema.safeParse(config).success, true);
        assert.deepEqual(new EmbedBuilder(renderEmbed(config)).toJSON(), renderEmbed(config));
        assert.ok(EmbedConfigSchema.safeParse({ fields: Array.from({ length: 25 }, () => ({ name: 'n', value: 'v' })) }).success);
    });
    it('validates and clears colors and normalizes reusable names', () => {
        assert.equal(parseColor('#5865F2'), 0x5865f2); assert.equal(parseColor('ffffff'), 0xffffff); assert.equal(parseColor(''), undefined);
        for (const input of ['red', '#fff', '1234567', '-12345']) assert.throws(() => parseColor(input));
        assert.equal(EmbedNameSchema.parse('  Support-Ticket  '), 'support-ticket');
    });
});

describe('builder session and component limits', () => {
    it('uses one optional paragraph Description input with a 4000-character limit', () => {
        sessions.clear();
        const s = createSession('100000000000000001', '100000000000000002');
        s.config.description = 'd'.repeat(4000);
        const modal = editorModal(s, 'Description').toJSON();
        assert.equal(modal.components.length, 1);
        const row = modal.components[0];
        assert.ok('components' in row);
        const input = row.components[0];
        assert.ok('max_length' in input);
        assert.equal(input.max_length, 4000); assert.equal(input.style, 2); assert.equal(input.required, false);
        assert.equal(input.value?.length, 4000);
        assert.doesNotMatch(JSON.stringify(modal), /continuation|96 characters/i);
    });
    it('creates a valid preview with metadata only in message content', () => {
        sessions.clear();
        const s = createSession('100000000000000001', '100000000000000002');
        s.channelId = '100000000000000003';
        const message = builderMessage(s);
        assert.match(message.content, /Fields: 0\/25/); assert.match(message.content, /<#100000000000000003>/);
        assert.doesNotMatch(JSON.stringify(message.embeds), /Embed Builder|Channel:|100000000000000003/);
        assert.doesNotThrow(() => new EmbedBuilder(message.embeds[0]).toJSON());
    });
    it('builds every modal and all 25 field options within component limits', () => {
        sessions.clear(); const s = createSession('100000000000000001', '100000000000000002');
        s.config.description = 'd'.repeat(4096);
        for (const action of [...EDITORS.filter(e => e !== 'Timestamp'), 'add-field', 'edit-field', 'save'] as const) {
            const modal = editorModal(s, action).toJSON();
            assert.ok(modal.components.length <= 5);
        }
        s.mode = 'fields'; s.config.fields = Array.from({ length: 25 }, (_, i) => ({ name: `Field ${i + 1}`, value: 'v', inline: false }));
        const rows = builderMessage(s).components.map(row => row.toJSON());
        assert.ok(rows.length <= 5);
        for (const row of rows) assert.ok(row.components.length <= 5);
        const select = rows[0].components[0];
        assert.ok('options' in select); assert.equal(select.options.length, 25);
    });
    it('validates atomically, preserves saved state and expires abandoned drafts', () => {
        sessions.clear();
        const saved = { id: '123e4567-e89b-42d3-a456-426614174000', guild_id: '100000000000000001', name: 'test', config: { description: 'Body', fields: [] } as EmbedConfig,
            created_by: '100000000000000002', published_channel_id: null, published_message_id: null, revision: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        const s = createSession(saved.guild_id, saved.created_by, saved, 100);
        assert.equal(isDirty(s), false);
        assert.throws(() => editDraft(s, c => { c.description = 'x'.repeat(4097); }));
        assert.equal(s.config.description, 'Body');
        editDraft(s, c => { c.title = 'Edited'; });
        assert.equal(isDirty(s), true); assert.equal(saved.config.title, undefined);
        expireSessions(100 + SESSION_TTL); assert.equal(sessions.size, 0);
    });
});
