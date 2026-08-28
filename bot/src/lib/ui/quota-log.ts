import { Client, EmbedBuilder, TextChannel } from 'discord.js';
import {
    getGuildChannels,
    markQuotaPeriodLogDelivery,
    type QuotaPeriod,
    type QuotaPeriodMemberResult,
} from '../utilities/http.js';
import { formatPoints } from '../utilities/format-helpers.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('QuotaLog');
const EMBED_DESCRIPTION_LIMIT = 3_800;

function splitMemberLines(lines: string[]): string[] {
    const chunks: string[] = [];
    let current = '';

    for (const line of lines) {
        const next = current.length === 0 ? line : `${current}\n${line}`;
        if (next.length > EMBED_DESCRIPTION_LIMIT && current.length > 0) {
            chunks.push(current);
            current = line;
        } else {
            current = next;
        }
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
}

function formatMemberResult(result: QuotaPeriodMemberResult): string {
    const sources: string[] = [];
    const hasCarryDetails = result.carry_in > 0 || result.carry_out > 0;

    if (hasCarryDetails && result.earned_points > 0) {
        sources.push(`${formatPoints(result.earned_points)} earned`);
    }
    if (result.carry_in > 0) {
        sources.push(`${formatPoints(result.carry_in)} rollover`);
    }

    let breakdown = sources.join(' + ');
    if (result.carry_out > 0) {
        const carryOut = `${formatPoints(result.carry_out)} carries`;
        breakdown = breakdown.length > 0 ? `${breakdown} → ${carryOut}` : carryOut;
    }

    const details = breakdown.length > 0 ? ` (${breakdown})` : '';
    return `${result.met_quota ? '✅' : '❌'} <@${result.user_id}> — ${formatPoints(result.effective_total)} pts${details}`;
}

export function buildQuotaLogEmbeds(period: QuotaPeriod, roleName: string): EmbedBuilder[] {
    const startsAt = Math.floor(new Date(period.starts_at).getTime() / 1_000);
    const endsAt = Math.floor(new Date(period.ends_at).getTime() / 1_000);
    const met = period.results.filter(result => result.met_quota).length;
    const missed = period.results.length - met;
    const header = new EmbedBuilder()
        .setTitle(`📜 ${roleName} Quota Period Finalized`)
        .setDescription(
            `**Role:** <@&${period.quota_role_id}>\n` +
            `**Period:** <t:${startsAt}:F> — <t:${endsAt}:F>\n` +
            `**Required:** ${formatPoints(period.required_points)} points\n` +
            `**Rollover:** ${period.rollover_enabled ? 'Enabled' : 'Disabled'}\n` +
            `**Result:** ${met} met / ${missed} missed\n` +
            `**Close reason:** ${period.close_reason ?? 'unknown'}\n` +
            (period.roster_complete
                ? '**Roster:** Complete live role roster included'
                : '**Roster:** Historical reconstruction; unverifiable zero-point members omitted')
        )
        .setColor(0x5865F2)
        .setTimestamp(period.finalized_at ? new Date(period.finalized_at) : new Date());

    const memberLines = period.results.map(formatMemberResult);
    const resultTitle = `${roleName} Member Results`;

    if (memberLines.length === 0) {
        return [header, new EmbedBuilder().setTitle(resultTitle).setDescription('No verifiable members for this period.').setColor(0x5865F2)];
    }

    const resultEmbeds = splitMemberLines(memberLines).map((description, index, chunks) =>
        new EmbedBuilder()
            .setTitle(chunks.length === 1 ? resultTitle : `${resultTitle} (${index + 1}/${chunks.length})`)
            .setDescription(description)
            .setColor(0x5865F2)
    );
    return [header, ...resultEmbeds];
}

/**
 * Deliver one persisted result. Each embed is its own message so the 6,000-character
 * aggregate embed limit cannot truncate a large roster.
 */
export async function deliverQuotaPeriodLog(client: Client, period: QuotaPeriod): Promise<boolean> {
    try {
        const guild = client.guilds.cache.get(period.guild_id);
        if (!guild) {
            await markQuotaPeriodLogDelivery(period.id, false);
            return false;
        }

        const channels = await getGuildChannels(period.guild_id);
        const channelId = channels.channels.quota_log;
        if (!channelId) {
            await markQuotaPeriodLogDelivery(period.id, false);
            return false;
        }

        const channel = await guild.channels.fetch(channelId).catch(() => null);
        if (!channel?.isTextBased()) {
            await markQuotaPeriodLogDelivery(period.id, false);
            return false;
        }

        const roleName = guild.roles.cache.get(period.quota_role_id)?.name ?? `Deleted role ${period.quota_role_id}`;
        for (const embed of buildQuotaLogEmbeds(period, roleName)) {
            await (channel as TextChannel).send({ embeds: [embed] });
        }
        await markQuotaPeriodLogDelivery(period.id, true);
        return true;
    } catch (error) {
        await markQuotaPeriodLogDelivery(period.id, false).catch(() => undefined);
        logger.warn('Failed to deliver quota-period log', {
            guildId: period.guild_id,
            periodId: period.id,
            error: error instanceof Error ? error.message : String(error),
        });
        return false;
    }
}
