import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();
vi.mock('../../db/pool.js', () => ({ query: queryMock }));

const { getDungeonImage, setDungeonImage } = await import('./dungeon-image-service.js');

const png = Buffer.from('89504e470d0a1a0a', 'hex');

function row(guildId: string, data = png) {
    return {
        guild_id: guildId,
        dungeon_key: 'SNAKE_PIT',
        image_data: data,
        content_type: 'image/png' as const,
        filename: 'snake.png',
        updated_at: new Date('2026-09-04T01:00:00.000Z'),
    };
}

beforeEach(() => queryMock.mockReset());

describe('dungeon image persistence', () => {
    it('upserts by guild and dungeon and preserves repost metadata', async () => {
        queryMock.mockResolvedValueOnce({ rows: [row('100000000000000001')] });

        const stored = await setDungeonImage({
            guildId: '100000000000000001',
            dungeonKey: 'SNAKE_PIT',
            data: png,
            contentType: 'image/png',
            filename: 'snake.png',
        });

        expect(queryMock.mock.calls[0][0]).toContain('ON CONFLICT (guild_id, dungeon_key) DO UPDATE');
        expect(queryMock.mock.calls[0][1]).toEqual([
            '100000000000000001', 'SNAKE_PIT', png, 'image/png', 'snake.png',
        ]);
        expect(stored).toMatchObject({
            guildId: '100000000000000001',
            dungeonKey: 'SNAKE_PIT',
            data: png,
            contentType: 'image/png',
            filename: 'snake.png',
            updatedAt: '2026-09-04T01:00:00.000Z',
        });
    });

    it('retrieves durable bytes independently for each guild', async () => {
        const first = Buffer.concat([png, Buffer.from([1])]);
        const second = Buffer.concat([png, Buffer.from([2])]);
        queryMock
            .mockResolvedValueOnce({ rows: [row('100000000000000001', first)] })
            .mockResolvedValueOnce({ rows: [row('100000000000000002', second)] });

        const imageA = await getDungeonImage('100000000000000001', 'SNAKE_PIT');
        const imageB = await getDungeonImage('100000000000000002', 'SNAKE_PIT');

        expect(queryMock.mock.calls[0][1]).toEqual(['100000000000000001', 'SNAKE_PIT']);
        expect(queryMock.mock.calls[1][1]).toEqual(['100000000000000002', 'SNAKE_PIT']);
        expect(imageA?.data).toEqual(first);
        expect(imageB?.data).toEqual(second);
    });

    it('returns null when no image is configured', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        await expect(getDungeonImage('100000000000000001', 'NEST')).resolves.toBeNull();
    });
});
