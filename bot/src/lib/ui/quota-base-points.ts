import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { z } from 'zod';
import { DecimalPointsSchema } from '../utilities/decimal-points.js';
import { formatPoints } from '../utilities/format-helpers.js';

export const QuotaBasePointsSchema = z.object({
    base_exalt_points: DecimalPointsSchema,
    base_non_exalt_points: DecimalPointsSchema,
    misc_points_per_minute: DecimalPointsSchema,
});

export const MINUTE_QUOTA_LABEL = 'Non-Exalt Dungeon Minute Rate';
export const MINUTE_QUOTA_DESCRIPTION = 'Applies to single non-exalt runs, Realm Clearing, and multi non-exalt runs. Optional dungeon points are added for each Dungeon Entered.';

export function minuteQuotaPointSource(rate: number): string {
    return `**Non-Exalt Dungeons:** ${formatPoints(rate)}/min`;
}

export function buildQuotaBasePointsModal(
    roleId: string,
    messageId: string,
    config: z.output<typeof QuotaBasePointsSchema> | null
): ModalBuilder {
    const fields = [
        ['base_exalt_points', 'Base Exalt Dungeon Points', config?.base_exalt_points ?? 1],
        ['base_non_exalt_points', 'Base Non-Exalt Dungeon Points (additive)', config?.base_non_exalt_points ?? 0],
        ['misc_points_per_minute', MINUTE_QUOTA_LABEL, config?.misc_points_per_minute ?? 0.10],
    ] as const;

    return new ModalBuilder()
        .setCustomId(`quota_base_points_modal:${roleId}:${messageId}`)
        .setTitle('Configure Dungeon Points')
        .addComponents(fields.map(([id, label, value]) =>
            new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder()
                    .setCustomId(id)
                    .setLabel(label)
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setMaxLength(11)
                    .setValue(value.toFixed(2))
            )
        ));
}
