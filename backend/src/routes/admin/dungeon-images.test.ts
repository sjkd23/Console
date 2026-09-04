import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    authorized: true,
    stored: new Map<string, {
        guildId: string;
        dungeonKey: string;
        data: Buffer;
        contentType: 'image/png';
        filename: string;
        updatedAt: string;
    }>(),
}));

vi.mock('../../lib/auth/authorization.js', () => ({
    hasRequiredRoleOrHigher: vi.fn(async () => state.authorized),
}));
vi.mock('../../lib/database/database-helpers.js', () => ({
    ensureGuildExists: vi.fn(),
    ensureMemberExists: vi.fn(),
}));
vi.mock('../../lib/logging/audit.js', () => ({ logAudit: vi.fn() }));
vi.mock('../../lib/services/dungeon-image-service.js', () => ({
    getDungeonImage: vi.fn(async (guildId: string, dungeonKey: string) =>
        state.stored.get(`${guildId}:${dungeonKey}`) ?? null),
    setDungeonImage: vi.fn(async (options: {
        guildId: string;
        dungeonKey: string;
        data: Buffer;
        contentType: 'image/png';
        filename: string;
    }) => {
        const stored = { ...options, updatedAt: '2026-09-04T01:00:00.000Z' };
        state.stored.set(`${options.guildId}:${options.dungeonKey}`, stored);
        return stored;
    }),
}));

const { default: routes } = await import('./dungeon-images.js');
const pngBase64 = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');

async function buildApp() {
    const app = Fastify();
    await app.register(routes);
    return app;
}

beforeEach(() => {
    state.authorized = true;
    state.stored.clear();
});

describe('dungeon image routes', () => {
    it('stores, replaces, and retrieves image bytes after the upload request is gone', async () => {
        const app = await buildApp();
        const basePayload = {
            actor_user_id: '100000000000000003',
            actor_roles: ['100000000000000004'],
            image_base64: pngBase64,
            content_type: 'image/png',
            filename: 'snake.png',
        };

        expect((await app.inject({
            method: 'PUT', url: '/guilds/100000000000000001/dungeon-images/SNAKE_PIT', payload: basePayload,
        })).statusCode).toBe(200);
        expect((await app.inject({
            method: 'PUT', url: '/guilds/100000000000000001/dungeon-images/SNAKE_PIT',
            payload: { ...basePayload, filename: 'replacement.png' },
        })).statusCode).toBe(200);

        const fetched = await app.inject({
            method: 'GET', url: '/guilds/100000000000000001/dungeon-images/SNAKE_PIT',
        });
        expect(fetched.json().image).toMatchObject({
            image_base64: pngBase64,
            content_type: 'image/png',
            filename: 'replacement.png',
        });
        expect(state.stored.size).toBe(1);
        await app.close();
    });

    it('keeps the same dungeon isolated between guilds', async () => {
        const app = await buildApp();
        const payload = {
            actor_user_id: '100000000000000003',
            actor_has_admin_permission: true,
            image_base64: pngBase64,
            content_type: 'image/png',
            filename: 'snake.png',
        };
        await app.inject({ method: 'PUT', url: '/guilds/100000000000000001/dungeon-images/SNAKE_PIT', payload });
        await app.inject({
            method: 'PUT', url: '/guilds/100000000000000002/dungeon-images/SNAKE_PIT',
            payload: { ...payload, filename: 'other.png' },
        });
        expect(state.stored.size).toBe(2);
        await app.close();
    });

    it('rejects unauthorized, non-image, and Realm Clearing uploads', async () => {
        const app = await buildApp();
        const payload = {
            actor_user_id: '100000000000000003',
            actor_roles: ['100000000000000004'],
            image_base64: pngBase64,
            content_type: 'image/png',
            filename: 'image.png',
        };
        state.authorized = false;
        expect((await app.inject({
            method: 'PUT', url: '/guilds/100000000000000001/dungeon-images/SNAKE_PIT', payload,
        })).statusCode).toBe(403);
        state.authorized = true;
        expect((await app.inject({
            method: 'PUT', url: '/guilds/100000000000000001/dungeon-images/SNAKE_PIT',
            payload: { ...payload, image_base64: Buffer.from('not an image').toString('base64') },
        })).statusCode).toBe(400);
        expect((await app.inject({
            method: 'PUT', url: '/guilds/100000000000000001/dungeon-images/REALM_DUNGEON', payload,
        })).statusCode).toBe(400);
        await app.close();
    });
});
