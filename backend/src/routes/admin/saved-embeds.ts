import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { EmbedActorSchema, EmbedConfigSchema, EmbedNameSchema, SnowflakeSchema, PublicationSchema } from '../../lib/embeds/contract.js';
import { hasRequiredRoleOrHigher } from '../../lib/auth/authorization.js';
import { ensureGuildExists } from '../../lib/database/database-helpers.js';
import { Errors } from '../../lib/errors/errors.js';
import * as service from '../../lib/services/saved-embed-service.js';

const Params = z.object({ guild_id: SnowflakeSchema, id: z.string().uuid().optional() });
const Body = EmbedActorSchema.extend({
    name: EmbedNameSchema.optional(), config: EmbedConfigSchema.optional(), revision: z.number().int().positive().optional(),
    search: z.string().max(64).default(''), page: z.number().int().min(0).max(100000).default(0),
    publication: PublicationSchema.nullable().optional(),
});
export default async function savedEmbedRoutes(app: FastifyInstance): Promise<void> {
    // POST reads carry the same authenticated actor context as mutations, without role IDs in URLs/logs.
    for (const action of ['list', 'get', 'create', 'update', 'delete', 'claim', 'publication'] as const) {
        const path = `/guilds/:guild_id/saved-embeds/${action === 'list' || action === 'create' ? '' : ':id/'}${action}`;
        app.post(path, async (req, reply) => {
            const params = Params.safeParse(req.params);
            const body = Body.safeParse(req.body);
            if (!params.success || !body.success) return Errors.validation(reply, body.success ? 'Invalid guild or embed ID.' : body.error.issues[0].message);
            const { guild_id, id } = params.data;
            const { actor_user_id, actor_roles, actor_has_admin_permission, config, name, revision, search, page } = body.data;
            if (!actor_has_admin_permission && !await hasRequiredRoleOrHigher(guild_id, actor_user_id, 'moderator', actor_roles)) {
                return Errors.notAuthorized(reply, 'Moderator permission or higher is required.');
            }
            const missing = () => reply.code(404).send({ error: { code: 'EMBED_NOT_FOUND', message: 'That saved embed no longer exists in this server.' } });
            const conflict = (message: string) => reply.code(409).send({ error: { code: 'EMBED_CONFLICT', message } });
            if (action === 'list') return service.listSavedEmbeds(guild_id, search, page);
            if (action === 'get') {
                const embed = id ? await service.getSavedEmbed(guild_id, id) : null;
                return embed ? { embed } : missing();
            }
            if (action === 'create') {
                if (!config || !name) return Errors.validation(reply, 'A name and valid embed are required.');
                await ensureGuildExists(guild_id);
                const embed = await service.createSavedEmbed(guild_id, name, config, actor_user_id);
                if (!embed) return conflict('That name already exists. Choose another name, or open it with /editembed and use Save Changes to update it.');
                app.log.info({ guildId: guild_id, userId: actor_user_id, embedId: embed.id, name }, 'Saved embed created');
                return { embed };
            }
            if (!id || !revision) return Errors.validation(reply, 'Embed ID and revision are required.');
            if (!await service.getSavedEmbed(guild_id, id)) return missing();
            if (action === 'claim' || action === 'publication') {
                const publication = body.data.publication;
                if (action === 'publication' && (publication === undefined || (publication && publication.guild_id !== guild_id))) {
                    return Errors.validation(reply, 'Publication must belong to this server.');
                }
                let embed: Awaited<ReturnType<typeof service.claimSavedEmbed>>;
                try {
                    embed = action === 'claim' ? await service.claimSavedEmbed(guild_id, id, revision)
                        : await service.setEmbedPublication(guild_id, id, revision, publication ?? null);
                } catch (error) {
                    if (z.object({ code: z.literal('23505') }).safeParse(error).success) return conflict('That Discord message is already tracked by another saved embed.');
                    throw error;
                }
                if (!embed) return conflict('This saved embed changed. Reopen it before managing its published message.');
                app.log.info({ guildId: guild_id, userId: actor_user_id, embedId: id, channelId: embed.published_channel_id, messageId: embed.published_message_id, action }, 'Saved embed publication management');
                return { embed };
            }
            if (action === 'update') {
                if (!config) return Errors.validation(reply, 'A valid embed is required.');
                const embed = await service.updateSavedEmbed(guild_id, id, config, revision);
                if (!embed) return conflict('This saved embed changed. Reopen it before saving to avoid overwriting another edit.');
                app.log.info({ guildId: guild_id, userId: actor_user_id, embedId: id }, 'Saved embed updated');
                return { embed };
            }
            try {
                if (!await service.deleteSavedEmbed(guild_id, id, revision)) return conflict('This saved embed changed. Run /deleteembed again to review the current version.');
            } catch (error) {
                if (z.object({ code: z.literal('23503') }).safeParse(error).success) return conflict('This embed is referenced by another feature and cannot be deleted.');
                throw error;
            }
            app.log.info({ guildId: guild_id, userId: actor_user_id, embedId: id }, 'Saved embed deleted');
            return { deleted: true };
        });
    }
}
