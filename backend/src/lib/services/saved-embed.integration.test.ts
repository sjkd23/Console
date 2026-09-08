import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ pool: undefined as Pool | undefined, authorized: true }));
vi.mock('../../db/pool.js', () => ({ query: (sql: string, values?: unknown[]) => state.pool!.query(sql, values) }));
vi.mock('../auth/authorization.js', () => ({ hasRequiredRoleOrHigher: async () => state.authorized }));
vi.mock('../database/database-helpers.js', () => ({ ensureGuildExists: async () => undefined }));
import routes from '../../routes/admin/saved-embeds.js';
import * as service from './saved-embed-service.js';
import { EmbedConfigSchema } from '../embeds/contract.js';
import authPlugin from '../../plugins/auth.js';
import { backendConfig } from '../../config.js';

const integration = describe.runIf(Boolean(process.env.TEST_DATABASE_URL));
integration('saved embeds PostgreSQL and HTTP integration', () => {
    const schema = `embed_test_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const app = Fastify();
    const guildA = '100000000000000001', guildB = '100000000000000002', user = '100000000000000003';
    const actor = { actor_user_id: user, actor_roles: [], actor_has_admin_permission: false };
    const config = EmbedConfigSchema.parse({ title: 'Rules', description: 'Body', color: 0x5865f2,
        fields: [{ name: 'First', value: '1', inline: true }, { name: 'Second', value: '2', inline: false }],
        footer: { text: 'Footer', icon_url: 'https://example.com/icon.png' }, author: { name: 'Staff', url: 'https://example.com' },
        timestamp: '2026-09-07T00:00:00.000Z', image: { url: 'https://example.com/image.png' }, thumbnail: { url: 'https://example.com/thumb.png' }, url: 'https://example.com/rules' });
    async function request(guild: string, action: string, payload: Record<string, unknown> = {}, id?: string) {
        return app.inject({ method: 'POST', url: `/guilds/${guild}/saved-embeds/${id ? `${id}/` : ''}${action}`, headers: { 'x-api-key': backendConfig.BACKEND_API_KEY }, payload: { ...actor, ...payload } });
    }
    beforeAll(async () => {
        await admin.query(`CREATE SCHEMA ${schema}`);
        state.pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
        await state.pool.query('CREATE TABLE guild (id BIGINT PRIMARY KEY)');
        await state.pool.query(readFileSync(resolve('src/db/migrations/075_saved_embeds.sql'), 'utf8'));
        await state.pool.query(readFileSync(resolve('src/db/migrations/076_saved_embed_publication.sql'), 'utf8'));
        await state.pool.query('INSERT INTO guild (id) VALUES ($1), ($2)', [guildA, guildB]);
        await app.register(authPlugin);
        await app.register(routes);
    });
    beforeEach(async () => { state.authorized = true; await state.pool!.query('DELETE FROM saved_embed'); });
    afterAll(async () => {
        await app.close(); await state.pool?.end();
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
    });
    it('creates structured configuration and preserves all properties and field order on reads', async () => {
        const created = await request(guildA, 'create', { name: ' Support-Ticket ', config });
        expect(created.statusCode).toBe(200);
        const { embed } = created.json();
        expect(embed.name).toBe('support-ticket'); expect(embed.config).toEqual(config);
        expect(await service.getSavedEmbed(guildA, embed.id)).toEqual(embed);
        const fetched = await request(guildA, 'get', {}, embed.id); expect(fetched.json().embed).toEqual(embed);
    });
    it('rejects normalized duplicate names without overwriting, permits the same name in another guild', async () => {
        await request(guildA, 'create', { name: 'rules', config });
        expect((await request(guildA, 'create', { name: ' RULES ', config: { description: 'Replacement' } })).statusCode).toBe(409);
        expect((await request(guildB, 'create', { name: 'rules', config })).statusCode).toBe(200);
        expect((await service.listSavedEmbeds(guildA)).embeds.length).toBe(1);
    });
    it('scopes get, list, search, update and delete by guild in HTTP and data access', async () => {
        const saved = await service.createSavedEmbed(guildA, 'private-rules', config, user); expect(saved).not.toBeNull();
        for (const action of ['get', 'update', 'delete', 'claim', 'publication']) {
            expect((await request(guildB, action, { config, revision: 1 }, saved!.id)).statusCode).toBe(404);
        }
        expect((await request(guildB, 'list', { search: 'private' })).json().embeds).toEqual([]);
        expect(await service.getSavedEmbed(guildB, saved!.id)).toBeNull();
        expect(await service.updateSavedEmbed(guildB, saved!.id, config, 1)).toBeNull();
        expect(await service.deleteSavedEmbed(guildB, saved!.id, 1)).toBe(false);
        expect(await service.getSavedEmbed(guildA, saved!.id)).not.toBeNull();
    });
    it('updates only on save and refuses concurrent stale saves and stale deletion', async () => {
        const saved = await service.createSavedEmbed(guildA, 'rules', config, user);
        const draft = structuredClone(saved!.config); draft.title = 'Edited';
        expect((await service.getSavedEmbed(guildA, saved!.id))!.config.title).toBe('Rules');
        const updated = await request(guildA, 'update', { config: draft, revision: 1 }, saved!.id);
        expect(updated.json().embed.revision).toBe(2); expect(updated.json().embed.config.title).toBe('Edited');
        expect((await request(guildA, 'update', { config, revision: 1 }, saved!.id)).statusCode).toBe(409);
        expect((await request(guildA, 'delete', { revision: 1 }, saved!.id)).statusCode).toBe(409);
        expect((await request(guildA, 'delete', { revision: 2 }, saved!.id)).json()).toEqual({ deleted: true });
        expect((await request(guildA, 'get', {}, saved!.id)).statusCode).toBe(404);
    });
    it('lists stable pages and prefix search without exposing embed bodies', async () => {
        for (let i = 0; i < 27; i++) await service.createSavedEmbed(guildA, `rules-${String(i).padStart(2, '0')}`, config, user);
        const first = (await request(guildA, 'list')).json(); const second = (await request(guildA, 'list', { page: 1 })).json();
        expect(first.embeds).toHaveLength(25); expect(first.has_more).toBe(true); expect(second.embeds).toHaveLength(2); expect(second.has_more).toBe(false);
        expect(first.embeds[0]).not.toHaveProperty('config');
        expect((await request(guildA, 'list', { search: 'rules-26' })).json().embeds).toHaveLength(1);
        expect((await request(guildA, 'list', { search: '%' })).json().embeds).toHaveLength(0);
    });
    it('rejects unauthorized actors on every route and malformed actor payloads', async () => {
        state.authorized = false;
        for (const action of ['create', 'list', 'get', 'update', 'delete', 'claim', 'publication']) {
            const id = ['get', 'update', 'delete', 'claim', 'publication'].includes(action) ? randomUUID() : undefined;
            expect((await request(guildA, action, { config, name: 'rules', revision: 1 }, id)).statusCode).toBe(403);
        }
        expect((await request(guildA, 'create', { config, name: 'rules', actor_has_admin_permission: true })).statusCode).toBe(200);
        expect((await request(guildA, 'list', { actor_user_id: 'invalid' })).statusCode).toBe(400);
    });
    it('requires the shared bot/backend secret even when the actor claims Administrator', async () => {
        const response = await app.inject({ method: 'POST', url: `/guilds/${guildA}/saved-embeds/list`, payload: { ...actor, actor_has_admin_permission: true } });
        expect(response.statusCode).toBe(401);
    });
    it('stores publication IDs, retains them through config updates, and clears them as a pair', async () => {
        const saved = await service.createSavedEmbed(guildA, 'rules', config, user);
        expect(saved!.published_channel_id).toBeNull(); expect(saved!.published_message_id).toBeNull();
        const publication = { guild_id: guildA, channel_id: '100000000000000004', message_id: '100000000000000005' };
        const tracked = (await request(guildA, 'publication', { revision: 1, publication }, saved!.id)).json().embed;
        expect(tracked.published_channel_id).toBe(publication.channel_id); expect(tracked.published_message_id).toBe(publication.message_id);
        const changed = await service.updateSavedEmbed(guildA, saved!.id, { ...config, title: 'Updated' }, tracked.revision);
        expect(changed!.published_message_id).toBe(publication.message_id);
        const beforeRead = await service.getSavedEmbed(guildA, saved!.id);
        expect(await service.getSavedEmbed(guildA, saved!.id)).toEqual(beforeRead);
        const cleared = await service.setEmbedPublication(guildA, saved!.id, changed!.revision, null);
        expect(cleared!.published_channel_id).toBeNull(); expect(cleared!.published_message_id).toBeNull();
    });
    it('rejects cross-guild publication bodies, stale publication writes and stale operation claims', async () => {
        const saved = await service.createSavedEmbed(guildA, 'rules', config, user);
        const publication = { guild_id: guildB, channel_id: '100000000000000004', message_id: '100000000000000005' };
        expect((await request(guildA, 'publication', { revision: 1, publication }, saved!.id)).statusCode).toBe(400);
        await expect(service.setEmbedPublication(guildA, saved!.id, 1, publication)).rejects.toThrow('guild');
        const claim = await service.claimSavedEmbed(guildA, saved!.id, 1);
        expect(claim!.revision).toBe(2); expect(claim!.config).toEqual(config);
        expect(await service.claimSavedEmbed(guildA, saved!.id, 1)).toBeNull();
        expect(await service.claimSavedEmbed(guildB, saved!.id, 2)).toBeNull();
        expect((await request(guildA, 'publication', { revision: 1, publication: null }, saved!.id)).statusCode).toBe(409);
        expect(await service.updateSavedEmbed(guildA, saved!.id, config, 1)).toBeNull();
        expect(await service.deleteSavedEmbed(guildA, saved!.id, 1)).toBe(false);
    });
    it('migration enforces paired references and exclusive canonical message ownership', async () => {
        const first = await service.createSavedEmbed(guildA, 'one', config, user);
        const second = await service.createSavedEmbed(guildA, 'two', config, user);
        await expect(state.pool!.query('UPDATE saved_embed SET published_channel_id = $1 WHERE id = $2', ['100000000000000004', first!.id])).rejects.toMatchObject({ code: '23514' });
        const publication = { guild_id: guildA, channel_id: '100000000000000004', message_id: '100000000000000005' };
        await service.setEmbedPublication(guildA, first!.id, 1, publication);
        const duplicate = await request(guildA, 'publication', { revision: 1, publication }, second!.id);
        expect(duplicate.statusCode).toBe(409); expect(duplicate.json().error.message).toContain('already tracked');
    });
    it('validates aggregate, individual, URL and empty-content constraints before persistence', async () => {
        for (const invalid of [{}, { description: 'd'.repeat(4097) }, { description: 'd'.repeat(4000), footer: { text: 'f'.repeat(2001) } },
            { title: 't', image: { url: 'javascript:alert(1)' } }, { fields: [{ name: '', value: 'v' }] }, { fields: Array.from({ length: 26 }, () => ({ name: 'n', value: 'v' })) }]) {
            expect((await request(guildA, 'create', { name: 'rules', config: invalid })).statusCode).toBe(400);
        }
        expect((await service.listSavedEmbeds(guildA)).embeds).toEqual([]);
    });
    it('supports future guild-safe foreign keys and reports references as a friendly conflict', async () => {
        const saved = await service.createSavedEmbed(guildA, 'rules', config, user);
        await state.pool!.query('CREATE TABLE future_reference (guild_id BIGINT, embed_id UUID, FOREIGN KEY (guild_id, embed_id) REFERENCES saved_embed(guild_id, id) ON DELETE RESTRICT)');
        try {
            await expect(state.pool!.query('INSERT INTO future_reference VALUES ($1, $2)', [guildB, saved!.id])).rejects.toMatchObject({ code: '23503' });
            await state.pool!.query('INSERT INTO future_reference VALUES ($1, $2)', [guildA, saved!.id]);
            const response = await request(guildA, 'delete', { revision: 1 }, saved!.id);
            expect(response.statusCode).toBe(409); expect(response.json().error.message).toContain('referenced');
        } finally { await state.pool!.query('DROP TABLE future_reference'); }
    });
});
