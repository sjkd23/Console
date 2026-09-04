import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { downloadDungeonImage, DungeonImageValidationError } from './dungeon-image.js';

afterEach(() => mock.restoreAll());

describe('dungeon image attachment validation', () => {
    it('accepts a signature-valid image and preserves repost metadata', async () => {
        const png = Buffer.from('89504e470d0a1a0a', 'hex');
        mock.method(globalThis, 'fetch', async () => new Response(png, { status: 200 }));
        const upload = await downloadDungeonImage({
            url: 'https://cdn.discord.test/image',
            name: 'Snake Guide.PNG',
            size: png.length,
            contentType: 'image/png',
        });
        assert.equal(upload.contentType, 'image/png');
        assert.equal(upload.filename, 'Snake-Guide.png');
        assert.deepEqual(upload.data, png);
    });

    it('rejects a non-image attachment even when its declared type is allowed', async () => {
        const bytes = Buffer.from('not an image');
        mock.method(globalThis, 'fetch', async () => new Response(bytes, { status: 200 }));
        await assert.rejects(() => downloadDungeonImage({
            url: 'https://cdn.discord.test/fake',
            name: 'fake.png',
            size: bytes.length,
            contentType: 'image/png',
        }), DungeonImageValidationError);
    });
});
