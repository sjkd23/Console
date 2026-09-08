import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { TicketConfigSchema, TicketSchema, ConfigInputSchema, TicketPatchSchema, type ConfigInput, type TicketPatch } from '../tickets/contract.js';

function dates(row: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value]));
}
const configRow = (row: Record<string, unknown>) => TicketConfigSchema.parse(dates(row));
const ticketRow = (row: Record<string, unknown>) => TicketSchema.parse(dates(row));
export async function getConfig(guild: string, id: string) {
    const r = await query<Record<string, unknown>>('SELECT * FROM ticket_config WHERE guild_id=$1 AND id=$2', [guild, id]);
    return r.rows[0] ? configRow(r.rows[0]) : null;
}
export async function listConfigs(guild: string, search: string, page: number) {
    const r = await query<Record<string, unknown>>(`SELECT * FROM ticket_config WHERE guild_id=$1 AND starts_with(lower(name),lower($2)) ORDER BY name,id LIMIT 26 OFFSET $3`, [guild, search, page * 25]);
    return { configs: r.rows.slice(0, 25).map(configRow), has_more: r.rows.length > 25 };
}
export async function saveConfig(guild: string, user: string, input: ConfigInput, id?: string, revision?: number) {
    const c = ConfigInputSchema.parse(input);
    const values = [guild, c.name, c.panel_channel_id, c.category_id, JSON.stringify(c.panel_embed), JSON.stringify(c.opening_embed), JSON.stringify(c.staff_role_ids)];
    const r = id ? await query<Record<string, unknown>>(`UPDATE ticket_config SET name=$2,panel_channel_id=$3,category_id=$4,panel_embed=$5,opening_embed=$6,staff_role_ids=$7,
        updated_at=now(),revision=revision+1 WHERE guild_id=$1 AND id=$8 AND revision=$9 AND enabled RETURNING *`, [...values, id, revision], { redactParams: true })
        : await query<Record<string, unknown>>(`INSERT INTO ticket_config(guild_id,name,panel_channel_id,category_id,panel_embed,opening_embed,staff_role_ids,id,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [...values, randomUUID(), user], { redactParams: true });
    return r.rows[0] ? configRow(r.rows[0]) : null;
}
export async function manageConfig(guild: string, id: string, revision: number, action: 'claim' | 'disable' | 'publication', channel?: string, message?: string) {
    const r = await query<Record<string, unknown>>(`UPDATE ticket_config SET revision=revision+1,updated_at=now(),
        enabled=CASE WHEN $4='disable' THEN false ELSE enabled END,
        published_channel_id=CASE WHEN $4='publication' THEN $5::bigint ELSE published_channel_id END,
        panel_message_id=CASE WHEN $4='publication' THEN $6::bigint ELSE panel_message_id END
        WHERE guild_id=$1 AND id=$2 AND revision=$3 RETURNING *`, [guild, id, revision, action, channel ?? null, message ?? null]);
    return r.rows[0] ? configRow(r.rows[0]) : null;
}
export async function getTicket(guild: string, id: string) {
    const r = await query<Record<string, unknown>>('SELECT * FROM ticket WHERE guild_id=$1 AND id=$2', [guild, id]);
    return r.rows[0] ? ticketRow(r.rows[0]) : null;
}
export async function activeTickets(guild: string, after?: string) {
    const r = await query<Record<string, unknown>>(`SELECT * FROM ticket WHERE guild_id=$1 AND status IN ('creating','open','closing')
        AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT 200`, [guild, after ?? null]);
    return { tickets: r.rows.map(ticketRow), next: r.rows.length === 200 ? String(r.rows[199].id) : null };
}
/** The partial unique index arbitrates before the caller may create a Discord channel. */
export async function reserve(guild: string, config: string, user: string, roles: string[], operation: string) {
    const r = await query<Record<string, unknown>>(`WITH c AS (SELECT * FROM ticket_config WHERE guild_id=$1 AND id=$2 AND enabled FOR UPDATE)
        INSERT INTO ticket(id,guild_id,ticket_config_id,user_id,type_name,staff_role_ids,operation_id,lease_until)
        SELECT $3,$1,id,$4,name,$5,$6,now()+interval '5 minutes' FROM c
        ON CONFLICT DO NOTHING RETURNING *`, [guild, config, randomUUID(), user, JSON.stringify(roles), operation]);
    if (r.rows[0]) return { won: true, ticket: ticketRow(r.rows[0]) };
    const existing = await query<Record<string, unknown>>(`SELECT * FROM ticket WHERE guild_id=$1 AND ticket_config_id=$2 AND user_id=$3 AND status IN ('creating','open','closing')`, [guild, config, user]);
    return { won: false, ticket: existing.rows[0] ? ticketRow(existing.rows[0]) : null };
}
/** Fenced checkpoints: an expired worker cannot commit after recovery takes ownership. */
export async function checkpoint(guild: string, id: string, operation: string, input: TicketPatch) {
    const p = TicketPatchSchema.parse(input);
    const r = await query<Record<string, unknown>>(`UPDATE ticket SET channel_id=COALESCE($4,channel_id),log_channel_id=COALESCE($5,log_channel_id),
        log_message_id=COALESCE($6,log_message_id),thread_id=COALESCE($7,thread_id),opening_message_id=COALESCE($8,opening_message_id),
        status=COALESCE($9,status),updated_at=now(),lease_until=now()+interval '5 minutes',
        opened_at=CASE WHEN $9='open' THEN COALESCE(opened_at,now()) ELSE opened_at END,
        closed_at=CASE WHEN $9 IN ('closed','stale','failed') THEN COALESCE(closed_at,now()) ELSE closed_at END
        WHERE guild_id=$1 AND id=$2 AND operation_id=$3 AND status IN ('creating','closing')
        AND ($9::text IS NULL OR (status='creating' AND $9 IN ('open','failed')) OR (status='closing' AND $9 IN ('closed','stale','failed')))
        AND ($9 IS DISTINCT FROM 'open' OR (COALESCE($4,channel_id) IS NOT NULL AND COALESCE($5,log_channel_id) IS NOT NULL
            AND COALESCE($6,log_message_id) IS NOT NULL AND COALESCE($7,thread_id) IS NOT NULL AND COALESCE($8,opening_message_id) IS NOT NULL)) RETURNING *`,
    [guild, id, operation, p.channel_id ?? null, p.log_channel_id ?? null, p.log_message_id ?? null, p.thread_id ?? null, p.opening_message_id ?? null, p.status ?? null]);
    return r.rows[0] ? ticketRow(r.rows[0]) : null;
}
export async function acquireClose(guild: string, id: string, user: string | null, operation: string, recovery = false) {
    const r = await query<Record<string, unknown>>(`UPDATE ticket SET status='closing',operation_id=$4,lease_until=now()+interval '5 minutes',
        closed_by=COALESCE(closed_by,$3),closed_at=COALESCE(closed_at,now()),updated_at=now()
        WHERE guild_id=$1 AND id=$2 AND (status='open' OR ($5 AND status IN ('creating','closing') AND lease_until<now())) RETURNING *`, [guild, id, user, operation, recovery]);
    return r.rows[0] ? ticketRow(r.rows[0]) : null;
}
export const validRevision = z.number().int().positive();

export const EventSchema = z.object({ event_key: z.string().min(1).max(120), chunks: z.array(z.string().min(1).max(2000)).min(1).max(100), delivered: z.number().int().nonnegative() });
export async function enqueueTranscript(guild: string, id: string, key: string, chunks: string[]) {
    await query(`INSERT INTO ticket_transcript_event(ticket_id,event_key,chunks)
        SELECT id,$3,$4 FROM ticket WHERE guild_id=$1 AND id=$2 AND status IN ('creating','open','closing')
        ON CONFLICT DO NOTHING`, [guild, id, key, JSON.stringify(chunks)], { redactParams: true });
}
export async function pendingTranscript(guild: string, id: string) {
    const r = await query<Record<string, unknown>>(`SELECT e.event_key,e.chunks,e.delivered FROM ticket_transcript_event e JOIN ticket t ON t.id=e.ticket_id
        WHERE t.guild_id=$1 AND t.id=$2 AND e.delivered<jsonb_array_length(e.chunks) ORDER BY e.created_at,e.event_key LIMIT 100`, [guild, id], { redactParams: true });
    return r.rows.map(row => EventSchema.parse(row));
}
export async function acknowledgeTranscript(guild: string, id: string, key: string, delivered: number) {
    await query(`UPDATE ticket_transcript_event e SET delivered=$4 FROM ticket t WHERE t.id=e.ticket_id AND t.guild_id=$1 AND t.id=$2
        AND e.event_key=$3 AND e.delivered=$4-1 AND $4<=jsonb_array_length(e.chunks)`, [guild, id, key, delivered], { redactParams: true });
}
