import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { EmbedActorSchema, SnowflakeSchema } from '../../lib/embeds/contract.js';
import { ConfigInputSchema, ResourcesSchema, TicketPatchSchema } from '../../lib/tickets/contract.js';
import { hasRequiredRoleOrHigher } from '../../lib/auth/authorization.js';
import { ensureGuildExists, getGuildRoles } from '../../lib/database/database-helpers.js';
import * as service from '../../lib/services/ticket-service.js';

const Params = z.object({ guild_id: SnowflakeSchema, action: z.enum(['list','get','save','claim','publication','disable','reserve','ticket','active','checkpoint','close','recover','enqueue','pending','ack']) });
const Body = EmbedActorSchema.extend({
    id: z.string().uuid().optional(), revision: service.validRevision.optional(), config: ConfigInputSchema.optional(), resources: ResourcesSchema.optional(),
    search: z.string().max(64).default(''), page: z.number().int().min(0).max(100000).default(0),
    channel_id: SnowflakeSchema.optional(), message_id: SnowflakeSchema.optional(), operation_id: z.string().uuid().optional(),
    patch: TicketPatchSchema.optional(), after: z.string().uuid().optional(),
    event: service.EventSchema.optional(),
});
export default async function ticketRoutes(app: FastifyInstance): Promise<void> {
    app.post('/guilds/:guild_id/tickets/:action', async (req, reply) => {
        const p = Params.safeParse(req.params), b = Body.safeParse(req.body);
        const error = (code: number, message: string) => reply.code(code).send({ error: { code: 'TICKET_ERROR', message } });
        if (!p.success || !b.success) return error(400, 'Invalid ticket request.');
        const { guild_id: guild, action } = p.data;
        if (req.guildContext && req.guildContext.guildId !== guild) return error(403, 'Server context mismatch.');
        const body = b.data;
        const staff = body.actor_has_admin_permission || await hasRequiredRoleOrHigher(guild, body.actor_user_id, 'moderator', body.actor_roles);
        if (['list','get','save','claim','publication','disable'].includes(action) && !staff) return error(403, 'Moderator permission or higher is required.');
        const missing = () => error(404, 'This ticket panel or ticket no longer exists in this server.');
        const conflict = () => error(409, 'This ticket changed or is processing. Reopen the builder or retry shortly.');
        if (action === 'list') return service.listConfigs(guild, body.search, body.page);
        if (action === 'active') return service.activeTickets(guild, body.after); // Trusted bot restart/cache hydration.
        if (action === 'save') {
            const c = body.config, r = body.resources;
            if (!c || !r || r.panel.guild_id !== guild || r.category.guild_id !== guild || r.panel.id !== c.panel_channel_id || r.category.id !== c.category_id
                || c.staff_role_ids.some(id => id === guild || !r.roles.some(role => role.id === id && role.guild_id === guild))) return error(400, 'Resolve all channels and roles in this server before saving.');
            if (body.id && !body.revision) return error(400, 'Revision required.');
            await ensureGuildExists(guild);
            const config = await service.saveConfig(guild, body.actor_user_id, c, body.id, body.revision);
            app.log.info({ guildId: guild, configId: config?.id, action: body.id ? 'updated' : 'created' }, 'Ticket configuration saved');
            return config ? { config } : conflict();
        }
        if (!body.id) return error(400, 'Ticket or configuration ID required.');
        if (['get','claim','publication','disable','reserve'].includes(action)) {
            const config = await service.getConfig(guild, body.id);
            if (!config) return missing();
            if (action === 'get') return { config };
            if (action === 'reserve') {
                if (!config.enabled) return error(410, 'This ticket panel is no longer active.');
                if (!body.operation_id) return error(400, 'Operation ID required.');
                const mapping = await getGuildRoles(guild);
                const roles = [...new Set([...config.staff_role_ids, mapping.moderator, mapping.administrator].filter((r): r is string => Boolean(r) && r !== guild))];
                const result = await service.reserve(guild, config.id, body.actor_user_id, roles, body.operation_id);
                app.log.info({ guildId: guild, configId: config.id, ticketId: result.ticket?.id, won: result.won }, 'Ticket reservation');
                return { ...result, config };
            }
            if (!body.revision) return error(400, 'Revision required.');
            if (action === 'publication' && ((body.channel_id === undefined) !== (body.message_id === undefined))) return error(400, 'Both publication IDs are required.');
            if (action === 'publication' && body.channel_id && body.channel_id !== config.panel_channel_id) return error(400, 'Publication must use the validated destination.');
            const updated = await service.manageConfig(guild, config.id, body.revision, action as 'claim' | 'disable' | 'publication', body.channel_id, body.message_id);
            app.log.info({ guildId: guild, configId: config.id, action }, 'Ticket panel management');
            return updated ? { config: updated } : conflict();
        }
        const ticket = await service.getTicket(guild, body.id);
        if (!ticket) return missing();
        if (action === 'pending') return { events: await service.pendingTranscript(guild, ticket.id) };
        if (action === 'enqueue' || action === 'ack') {
            if (!body.event) return error(400, 'Transcript event required.');
            if (action === 'enqueue') await service.enqueueTranscript(guild, ticket.id, body.event.event_key, body.event.chunks);
            else await service.acknowledgeTranscript(guild, ticket.id, body.event.event_key, body.event.delivered);
            return { ok: true };
        }
        if (action === 'ticket') return { ticket };
        if (!body.operation_id) return error(400, 'Operation ID required.');
        if (action === 'close' && ticket.user_id !== body.actor_user_id && !staff && !ticket.staff_role_ids.some(id => body.actor_roles.includes(id))) return error(403, 'Only the creator or ticket staff can close this ticket.');
        const updated = action === 'checkpoint' ? await service.checkpoint(guild, ticket.id, body.operation_id, body.patch ?? {})
            : await service.acquireClose(guild, ticket.id, action === 'recover' ? null : body.actor_user_id, body.operation_id, action === 'recover');
        app.log.info({ guildId: guild, ticketId: ticket.id, action, status: updated?.status }, 'Ticket lifecycle');
        return updated ? { ticket: updated } : conflict();
    });
}
