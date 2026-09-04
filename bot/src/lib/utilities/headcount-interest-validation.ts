import { dungeonByCode } from '../../constants/dungeons/dungeon-helpers.js';
import { z } from 'zod';

const headcountInterestCustomIdSchema = z.string().transform((customId, context) => {
    const parts = customId.split(':');
    const parsed = z.tuple([
        z.literal('headcount'),
        z.literal('interest'),
        z.string().regex(/^\d+$/),
        z.string().min(1),
    ]).safeParse(parts);
    if (!parsed.success) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid headcount interest custom ID.' });
        return z.NEVER;
    }
    return { panelTimestamp: parsed.data[2], dungeonCode: parsed.data[3] };
});

export interface HeadcountInterestTarget {
    autoEndAt: Date;
    dungeonCodes: readonly string[];
}

export function parseHeadcountInterestCustomId(
    customId: string
): { panelTimestamp: string; dungeonCode: string } | null {
    const result = headcountInterestCustomIdSchema.safeParse(customId);
    return result.success ? result.data : null;
}

export function getHeadcountInterestRejection(
    activeHeadcount: HeadcountInterestTarget | null,
    dungeonCode: string,
    now = new Date()
): string | null {
    if (!activeHeadcount || activeHeadcount.autoEndAt.getTime() <= now.getTime()) {
        return '❌ This headcount is closed or expired.';
    }
    if (!dungeonByCode[dungeonCode] || !activeHeadcount.dungeonCodes.includes(dungeonCode)) {
        return '❌ That dungeon is not part of this headcount.';
    }
    return null;
}
