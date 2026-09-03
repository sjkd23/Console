import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { zSnowflake } from '../../lib/constants/constants.js';
import { Errors } from '../../lib/errors/errors.js';
import { ensureMemberExists } from '../../lib/database/database-helpers.js';
import { createLogger } from '../../lib/logging/logger.js';
import {
    OrganizerMinuteSettlementError,
    cancelOrganizerMinuteSettlement,
    confirmOrganizerMinuteSettlement,
    getOrganizerMinuteSettlement,
    recoverOrganizerMinutes,
    modifyOrganizerMinuteSettlement,
} from '../../lib/services/organizer-minute-settlement-service.js';

const logger = createLogger('OrganizerMinuteSettlements');
const Params = z.object({ id: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().positive().safe()) });
const ActorBody = z.object({ actorId: zSnowflake });
const ConfirmBody = ActorBody.extend({ expectedRevision: z.number().int().nonnegative().safe() });
const ModifyBody = ConfirmBody.extend({ selectedMinutes: z.number().int().positive().safe() });
const RecoveryBody = z.object({
    actorId: zSnowflake,
    selectedMinutes: z.number().int().positive().safe(),
});

function guildId(req: FastifyRequest, reply: FastifyReply): string | null {
    const id = req.guildContext?.guildId;
    if (!id || !/^\d+$/.test(id)) {
        Errors.notAuthorized(reply, 'Guild context is required.');
        return null;
    }
    return id;
}

function settlementError(reply: FastifyReply, error: unknown) {
    if (error instanceof OrganizerMinuteSettlementError) {
        return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    throw error;
}

export default async function organizerMinuteSettlementRoutes(app: FastifyInstance) {
    app.post('/runs/:id/minute-settlement/view', async (req, reply) => {
        const p = Params.safeParse(req.params);
        const b = ActorBody.safeParse(req.body);
        const guild = guildId(req, reply);
        if (!p.success || !b.success) return Errors.validation(reply);
        if (!guild) return;
        const settlement = await getOrganizerMinuteSettlement({ runId: p.data.id, guildId: guild });
        if (!settlement) return Errors.runNotFound(reply, p.data.id);
        if (settlement.organizerId !== b.data.actorId) return Errors.notAuthorized(reply, 'Only the original organizer may view minute logging.');
        return reply.send({ settlement });
    });

    app.post('/runs/:id/minute-settlement/confirm', async (req, reply) => {
        const p = Params.safeParse(req.params); const b = ConfirmBody.safeParse(req.body); const guild = guildId(req, reply);
        if (!p.success || !b.success) return Errors.validation(reply); if (!guild) return;
        try {
            const settlement = await confirmOrganizerMinuteSettlement({
                runId: p.data.id, guildId: guild, actorId: b.data.actorId, expectedRevision: b.data.expectedRevision,
            });
            logger.info({ runId: settlement.runId, guildId: guild, organizerId: settlement.organizerId,
                runKind: settlement.runKind, maxMinutes: settlement.maxMinutes,
                selectedMinutes: settlement.selectedMinutes, rate: settlement.rate,
                quotaPoints: settlement.selectedPoints }, 'Organizer confirmed minute quota');
            return reply.send({ settlement });
        } catch (error) { return settlementError(reply, error); }
    });

    app.patch('/runs/:id/minute-settlement', async (req, reply) => {
        const p = Params.safeParse(req.params); const b = ModifyBody.safeParse(req.body); const guild = guildId(req, reply);
        if (!p.success || !b.success) return Errors.validation(reply); if (!guild) return;
        try {
            return reply.send({ settlement: await modifyOrganizerMinuteSettlement({
                runId: p.data.id, guildId: guild, actorId: b.data.actorId,
                expectedRevision: b.data.expectedRevision, selectedMinutes: b.data.selectedMinutes,
            }) });
        } catch (error) { return settlementError(reply, error); }
    });

    app.post('/runs/:id/minute-settlement/cancel', async (req, reply) => {
        const p = Params.safeParse(req.params); const b = ActorBody.safeParse(req.body); const guild = guildId(req, reply);
        if (!p.success || !b.success) return Errors.validation(reply); if (!guild) return;
        try {
            return reply.send({ settlement: await cancelOrganizerMinuteSettlement({
                runId: p.data.id, guildId: guild, actorId: b.data.actorId,
            }) });
        } catch (error) { return settlementError(reply, error); }
    });

    app.post('/runs/:id/minute-settlement/recover', async (req, reply) => {
        const p = Params.safeParse(req.params); const b = RecoveryBody.safeParse(req.body); const guild = guildId(req, reply);
        if (!p.success || !b.success) return Errors.validation(reply); if (!guild) return;
        try {
            await ensureMemberExists(b.data.actorId);
            const result = await recoverOrganizerMinutes({
                runId: p.data.id, guildId: guild, actorId: b.data.actorId,
                selectedMinutes: b.data.selectedMinutes,
            });
            logger.info({ runId: result.settlement.runId, guildId: guild,
                organizerId: result.settlement.organizerId,
                selectedMinutes: result.settlement.selectedMinutes, rate: result.settlement.rate,
                quotaPoints: result.settlement.selectedPoints,
                alreadyConfirmed: result.alreadyConfirmed },
            'Organizer recovered minute logging');
            return reply.send(result);
        } catch (error) {
            return settlementError(reply, error);
        }
    });
}
