export const MAX_DUNGEON_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_DUNGEON_IMAGE_BASE64_LENGTH = 4 * Math.ceil(MAX_DUNGEON_IMAGE_BYTES / 3);

export const DUNGEON_IMAGE_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type DungeonImageContentType = typeof DUNGEON_IMAGE_CONTENT_TYPES[number];

export function detectDungeonImageContentType(data: Uint8Array): DungeonImageContentType | null {
    if (
        data.length >= 8
        && data[0] === 0x89
        && data[1] === 0x50
        && data[2] === 0x4e
        && data[3] === 0x47
        && data[4] === 0x0d
        && data[5] === 0x0a
        && data[6] === 0x1a
        && data[7] === 0x0a
    ) return 'image/png';

    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
        return 'image/jpeg';
    }

    if (
        data.length >= 12
        && String.fromCharCode(...data.subarray(0, 4)) === 'RIFF'
        && String.fromCharCode(...data.subarray(8, 12)) === 'WEBP'
    ) return 'image/webp';

    return null;
}

export function decodeDungeonImageBase64(value: string): Buffer | null {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length === 0 || decoded.length > MAX_DUNGEON_IMAGE_BYTES) return null;
    return decoded.toString('base64') === value ? decoded : null;
}
