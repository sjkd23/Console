import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    type Client,
} from 'discord.js';
import type { OrganizerMinuteSettlement } from '../utilities/organizer-minute-settlement-contract.js';
import { formatPoints } from '../utilities/format-helpers.js';
import { createLogger } from '../logging/logger.js';
import { logBotEvent } from '../logging/bot-logger.js';

const logger = createLogger('OrganizerMinuteSettlementUI');

export type MinuteRecordEndType = 'organizer_end' | 'staff_end' | 'automatic_end';

function minuteWord(minutes: number): string {
    return minutes === 1 ? 'minute' : 'minutes';
}

export function buildMinuteSettlementMessage(settlement: OrganizerMinuteSettlement) {
    if (settlement.status === 'confirmed') {
        return {
            embeds: [new EmbedBuilder().setTitle('✅ Minute Quota Awarded')
                .setDescription(`Awarded **${formatPoints(settlement.selectedPoints)} quota points** for **${settlement.selectedMinutes} ${minuteWord(settlement.selectedMinutes)}**.`)
                .setColor(0x00a86b)],
            components: [],
        };
    }
    if (settlement.status === 'cancelled') {
        return {
            embeds: [new EmbedBuilder().setTitle('Minute Quota Declined')
                .setDescription('Minute logging cancelled. No minute quota points were awarded.')
                .setColor(0x808080)],
            components: [],
        };
    }
    const loggingLine = settlement.revision > 0
        ? `**Logging:** ${settlement.selectedMinutes} ${minuteWord(settlement.selectedMinutes)}\n`
        : '';
    const embed = new EmbedBuilder().setTitle('Minute Quota')
        .setDescription(
            `**Run duration:** ${settlement.maxMinutes} ${minuteWord(settlement.maxMinutes)}\n` +
            loggingLine +
            `You will receive **${formatPoints(settlement.selectedPoints)} quota points**.\n\n` +
            'Click Confirm if this is accurate, Modify to change the number of minutes you want to log, ' +
            'or Cancel to skip logging these minutes.'
        ).setColor(0x5865f2);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`minute:confirm:${settlement.runId}:${settlement.revision}`).setLabel('Confirm').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`minute:modify:${settlement.runId}:${settlement.revision}`).setLabel('Modify').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`minute:cancel:${settlement.runId}`).setLabel('Cancel').setStyle(ButtonStyle.Danger),
    );
    return { embeds: [embed], components: [row] };
}

export function buildMinuteModifyModal(runId: number, revision: number, selectedMinutes: number): ModalBuilder {
    return new ModalBuilder().setCustomId(`minute:submit:${runId}:${revision}`).setTitle('Modify Minute Quota')
        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId('minutes').setLabel('Minutes to log')
                .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(16).setValue(String(selectedMinutes))
        ));
}

export async function sendMinuteRecordDm(
    client: Client,
    settlement: OrganizerMinuteSettlement,
    endType: MinuteRecordEndType,
    dependencies: {
        logDelivery?: (
            client: Client,
            settlement: OrganizerMinuteSettlement,
            endType: MinuteRecordEndType
        ) => Promise<void>;
    } = {}
): Promise<boolean> {
    try {
        const user = await client.users.fetch(settlement.organizerId);
        await user.send(buildMinuteRecordDm(settlement, endType));
    } catch (error) {
        logger.warn('Could not deliver minute run backup DM', {
            runId: settlement.runId,
            organizerId: settlement.organizerId,
            error: error instanceof Error ? error.message : String(error),
        });
        return false;
    }

    try {
        await (dependencies.logDelivery ?? logMinuteRecordDmSent)(client, settlement, endType);
    } catch (error) {
        logger.warn('Minute run backup DM was delivered, but its bot-log entry failed', {
            runId: settlement.runId,
            organizerId: settlement.organizerId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
    return true;
}

export function buildMinuteRecordDm(
    settlement: OrganizerMinuteSettlement,
    endType: MinuteRecordEndType
) {
    const command = `\`/logminutes run:${settlement.runId} minutes:${settlement.maxMinutes}\``;
    const recovery = endType === 'organizer_end'
        ? `If you closed or lost the minute logging prompt before submitting your minutes, use ${command} to log them later.`
        : `This run ended without your minute logging prompt. Use ${command} to log your minutes.`;
    return { embeds: [new EmbedBuilder().setTitle('Minute Run Record').setDescription(
        `You ran **${settlement.runLabel}** for **${settlement.maxMinutes} ${minuteWord(settlement.maxMinutes)}**, ` +
        `worth up to **${formatPoints(settlement.maxPoints)} quota points** at **${formatPoints(settlement.rate)}/min**.\n\n` +
        `${recovery}\n\n**Run reference:** ${settlement.runId}`
    ).setColor(0x5865f2)] };
}

export function buildMinuteRecordLog(
    settlement: OrganizerMinuteSettlement,
    endType: MinuteRecordEndType
) {
    const endLabels: Record<MinuteRecordEndType, string> = {
        organizer_end: 'Organizer End',
        staff_end: 'Staff End',
        automatic_end: 'Automatic End',
    };
    return {
        title: 'Minute record DM sent',
        description: 'A backup minute-record DM was delivered to the original organizer.',
        fields: [
            { name: 'Organizer', value: `<@${settlement.organizerId}> (${settlement.organizerId})`, inline: false },
            { name: 'Run', value: settlement.runLabel, inline: true },
            { name: 'Run reference', value: String(settlement.runId), inline: true },
            { name: 'Duration', value: `${settlement.maxMinutes} ${minuteWord(settlement.maxMinutes)}`, inline: true },
            { name: 'Rate', value: `${formatPoints(settlement.rate)}/min`, inline: true },
            { name: 'Maximum quota', value: `${formatPoints(settlement.maxPoints)} points`, inline: true },
            { name: 'End type', value: endLabels[endType], inline: true },
        ],
    };
}

async function logMinuteRecordDmSent(
    client: Client,
    settlement: OrganizerMinuteSettlement,
    endType: MinuteRecordEndType
): Promise<void> {
    const record = buildMinuteRecordLog(settlement, endType);
    await logBotEvent(client, settlement.guildId, record.title, record.description, {
        fields: record.fields,
    });
}
