import { z } from 'zod';
import { DecimalPointsSchema } from './decimal-points.js';

/** Backend-computed basis only: this is not settlement state and must not be recalculated here. */
export const OrganizerMinuteQuotaSchema = z.object({
    eligible: z.boolean(),
    snapshottedRate: DecimalPointsSchema.nullable(),
    quotaRoleId: z.string().regex(/^\d+$/).nullable(),
    maxWholeMinutes: z.number().int().nonnegative().safe().nullable(),
    maxPoints: DecimalPointsSchema.nullable(),
    invalidReason: z.enum(['invalid_timestamps', 'out_of_range']).nullable(),
});
