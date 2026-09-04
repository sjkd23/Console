import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DUNGEON_BY_CODE } from '../../config/raid-config.js';
import { zSnowflake } from '../../lib/constants/constants.js';
import { Errors } from '../../lib/errors/errors.js';
import { hasRequiredRoleOrHigher } from '../../lib/auth/authorization.js';
import { ensureGuildExists, ensureMemberExists } from '../../lib/database/database-helpers.js';
import { logAudit } from '../../lib/logging/audit.js';
import {
    decodeDungeonImageBase64,
    detectDungeonImageContentType,
    DUNGEON_IMAGE_CONTENT_TYPES,
    MAX_DUNGEON_IMAGE_BASE64_LENGTH,
} from '../../lib/images/dungeon-image.js';
import { getDungeonImage, setDungeonImage } from '../../lib/services/dungeon-image-service.js';

const MAX_REQUEST_BYTES = 12 * 1024 * 1024;

const Params = z.object({
    guild_id: zSnowflake,
    dungeon_key: z.string().min(1),
});

const PutDungeonImageBody = z.object({
    actor_user_id: zSnowflake,
    actor_roles: z.array(zSnowflake).optional(),
    actor_has_admin_permission: z.boolean().optional(),
    image_base64: z.string().min(1).max(MAX_DUNGEON_IMAGE_BASE64_LENGTH),
    content_type: z.enum(DUNGEON_IMAGE_CONTENT_TYPES),
    filename: z.string().trim().min(1).max(255),
});

function isConfigurableDungeon(dungeonKey: string): boolean {
    const dungeon = DUNGEON_BY_CODE.get(dungeonKey);
    return dungeon !== undefined && dungeon.selectionClass !== 'realm_clearing';
}

export default async function dungeonImageRoutes(app: FastifyInstance): Promise<void> {
    app.get('/guilds/:guild_id/dungeon-images/:dungeon_key', async (req, reply) => {
        const parsed = Params.safeParse(req.params);
        if (!parsed.success) return Errors.validation(reply, 'Invalid guild or dungeon.');
        const { guild_id, dungeon_key } = parsed.data;
        if (!isConfigurableDungeon(dungeon_key)) return Errors.validation(reply, 'Invalid dungeon.');

        const image = await getDungeonImage(guild_id, dungeon_key);
        return reply.send({
            image: image ? {
                dungeon_key: image.dungeonKey,
                image_base64: image.data.toString('base64'),
                content_type: image.contentType,
                filename: image.filename,
                updated_at: image.updatedAt,
            } : null,
        });
    });

    app.put('/guilds/:guild_id/dungeon-images/:dungeon_key', {
        bodyLimit: MAX_REQUEST_BYTES,
    }, async (req, reply) => {
        const params = Params.safeParse(req.params);
        const body = PutDungeonImageBody.safeParse(req.body);
        if (!params.success || !body.success) return Errors.validation(reply, 'Invalid dungeon image.');

        const { guild_id, dungeon_key } = params.data;
        if (!isConfigurableDungeon(dungeon_key)) return Errors.validation(reply, 'Invalid dungeon.');

        const {
            actor_user_id,
            actor_roles,
            actor_has_admin_permission,
            image_base64,
            content_type,
            filename,
        } = body.data;
        const authorized = actor_has_admin_permission === true
            || await hasRequiredRoleOrHigher(guild_id, actor_user_id, 'moderator', actor_roles);
        if (!authorized) return Errors.notAuthorized(reply);

        const imageData = decodeDungeonImageBase64(image_base64);
        const detectedContentType = imageData ? detectDungeonImageContentType(imageData) : null;
        if (!imageData || detectedContentType !== content_type) {
            return Errors.validation(reply, 'Invalid dungeon image.');
        }

        await ensureGuildExists(guild_id);
        await ensureMemberExists(actor_user_id);
        const previous = await getDungeonImage(guild_id, dungeon_key);
        const stored = await setDungeonImage({
            guildId: guild_id,
            dungeonKey: dungeon_key,
            data: imageData,
            contentType: content_type,
            filename,
        });
        await logAudit(guild_id, actor_user_id, 'guild.dungeon_image.set', dungeon_key, {
            replaced: previous !== null,
            content_type,
            filename,
            size: imageData.length,
        });

        return reply.send({
            image: {
                dungeon_key: stored.dungeonKey,
                image_base64: stored.data.toString('base64'),
                content_type: stored.contentType,
                filename: stored.filename,
                updated_at: stored.updatedAt,
            },
        });
    });
}
