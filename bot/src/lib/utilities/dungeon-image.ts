import { z } from 'zod';

export const MAX_DUNGEON_IMAGE_BYTES = 8 * 1024 * 1024;
export const DUNGEON_IMAGE_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type DungeonImageContentType = typeof DUNGEON_IMAGE_CONTENT_TYPES[number];

const AttachmentInputSchema = z.object({
    url: z.string().url(),
    name: z.string().nullable(),
    size: z.number().int().positive().max(MAX_DUNGEON_IMAGE_BYTES),
    contentType: z.string().nullable(),
});

export class DungeonImageValidationError extends Error { }

export interface DungeonImageUpload {
    data: Buffer;
    contentType: DungeonImageContentType;
    filename: string;
}

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

function normalizedDeclaredContentType(value: string | null): DungeonImageContentType | null {
    if (value === 'image/jpg') return 'image/jpeg';
    return DUNGEON_IMAGE_CONTENT_TYPES.find(contentType => contentType === value) ?? null;
}

function safeFilename(original: string | null, contentType: DungeonImageContentType): string {
    const extension = contentType === 'image/png' ? '.png' : contentType === 'image/jpeg' ? '.jpg' : '.webp';
    const stem = (original ?? 'dungeon-image')
        .replace(/\.[^.]*$/, '')
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 200);
    return `${stem || 'dungeon-image'}${extension}`;
}

export async function downloadDungeonImage(input: unknown): Promise<DungeonImageUpload> {
    const parsed = AttachmentInputSchema.safeParse(input);
    if (!parsed.success) {
        throw new DungeonImageValidationError('Image must be a PNG, JPEG, or WebP file up to 8 MiB.');
    }

    const declaredContentType = normalizedDeclaredContentType(parsed.data.contentType);
    if (!declaredContentType) {
        throw new DungeonImageValidationError('Image must be a PNG, JPEG, or WebP file.');
    }

    let response: Response;
    try {
        response = await fetch(parsed.data.url, { signal: AbortSignal.timeout(20_000) });
    } catch {
        throw new DungeonImageValidationError('Could not download that image. Try again.');
    }
    if (!response.ok) {
        throw new DungeonImageValidationError('Could not download that image. Try again.');
    }

    const data = Buffer.from(await response.arrayBuffer());
    const detectedContentType = detectDungeonImageContentType(data);
    if (
        data.length === 0
        || data.length > MAX_DUNGEON_IMAGE_BYTES
        || detectedContentType === null
        || detectedContentType !== declaredContentType
    ) {
        throw new DungeonImageValidationError('Image must be a PNG, JPEG, or WebP file up to 8 MiB.');
    }

    return {
        data,
        contentType: detectedContentType,
        filename: safeFilename(parsed.data.name, detectedContentType),
    };
}
