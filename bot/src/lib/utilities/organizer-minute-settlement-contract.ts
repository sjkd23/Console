import { z } from 'zod';
import { DecimalPointsSchema } from './decimal-points.js';

export const OrganizerMinuteSettlementSchema = z.object({
    runId: z.number().int().positive().safe(),
    guildId: z.string().regex(/^\d+$/),
    organizerId: z.string().regex(/^\d+$/),
    runKind: z.string().min(1),
    runLabel: z.string().min(1),
    quotaRoleId: z.string().regex(/^\d+$/),
    rate: DecimalPointsSchema,
    maxMinutes: z.number().int().positive().safe(),
    selectedMinutes: z.number().int().positive().safe(),
    selectedPoints: DecimalPointsSchema,
    maxPoints: DecimalPointsSchema,
    status: z.enum(['pending', 'confirmed', 'cancelled']),
    revision: z.number().int().nonnegative().safe(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    resolvedAt: z.string().datetime().nullable(),
    quotaEventId: z.number().int().positive().safe().nullable(),
    quotaEventCreatedAt: z.string().datetime().nullable(),
});

export const OrganizerMinuteSettlementResponseSchema = z.object({ settlement: OrganizerMinuteSettlementSchema });
export const OrganizerMinuteRecoveryResponseSchema = OrganizerMinuteSettlementResponseSchema.extend({
    alreadyConfirmed: z.boolean(),
});
export const EndRunResponseSchema = z.object({
    ok: z.literal(true),
    status: z.literal('ended'),
    organizerMinuteSettlement: OrganizerMinuteSettlementSchema.nullable(),
});
export type OrganizerMinuteSettlement = z.infer<typeof OrganizerMinuteSettlementSchema>;
