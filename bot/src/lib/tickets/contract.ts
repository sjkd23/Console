// Mirrored across Docker build contexts; tests enforce parity.
import { z } from 'zod';
import { EmbedConfigSchema, SnowflakeSchema } from '../embeds/contract.js';

export const TicketNameSchema = z.string().trim().min(1).max(64).refine(v => !/[\r\n\u0000-\u001f]/.test(v), 'Use a single-line ticket type.');
export const ConfigInputSchema = z.object({
    name: TicketNameSchema, panel_channel_id: SnowflakeSchema, category_id: SnowflakeSchema,
    panel_embed: EmbedConfigSchema, opening_embed: EmbedConfigSchema,
    staff_role_ids: z.array(SnowflakeSchema).max(20).default([]),
}).strict();
export const TicketConfigSchema = ConfigInputSchema.extend({
    id: z.string().uuid(), guild_id: SnowflakeSchema, enabled: z.boolean(),
    published_channel_id: SnowflakeSchema.nullable(), panel_message_id: SnowflakeSchema.nullable(),
    created_by: SnowflakeSchema, created_at: z.string().datetime(), updated_at: z.string().datetime(), revision: z.number().int().positive(),
});
export const TicketStatusSchema = z.enum(['creating', 'open', 'closing', 'closed', 'failed', 'stale']);
export const TicketSchema = z.object({
    id: z.string().uuid(), guild_id: SnowflakeSchema, ticket_config_id: z.string().uuid(), user_id: SnowflakeSchema,
    type_name: TicketNameSchema, staff_role_ids: z.array(SnowflakeSchema), status: TicketStatusSchema,
    channel_id: SnowflakeSchema.nullable(), log_channel_id: SnowflakeSchema.nullable(), log_message_id: SnowflakeSchema.nullable(),
    thread_id: SnowflakeSchema.nullable(), opening_message_id: SnowflakeSchema.nullable(),
    operation_id: z.string().uuid().nullable(), lease_until: z.string().datetime().nullable(),
    created_at: z.string().datetime(), updated_at: z.string().datetime(), opened_at: z.string().datetime().nullable(),
    closed_at: z.string().datetime().nullable(), closed_by: SnowflakeSchema.nullable(),
});
export const TicketPatchSchema = z.object({
    channel_id: SnowflakeSchema.optional(), log_channel_id: SnowflakeSchema.optional(), log_message_id: SnowflakeSchema.optional(),
    thread_id: SnowflakeSchema.optional(), opening_message_id: SnowflakeSchema.optional(),
    status: TicketStatusSchema.optional(),
}).strict();
// Discord IDs are resolved by the authenticated bot through guild-scoped REST fetches,
// never copied from custom IDs without checking their actual guild/type.
export const ResourcesSchema = z.object({
    panel: z.object({ id: SnowflakeSchema, guild_id: SnowflakeSchema, type: z.literal(0) }).strict(),
    category: z.object({ id: SnowflakeSchema, guild_id: SnowflakeSchema, type: z.literal(4) }).strict(),
    roles: z.array(z.object({ id: SnowflakeSchema, guild_id: SnowflakeSchema }).strict()).max(20),
}).strict();
export type TicketConfig = z.infer<typeof TicketConfigSchema>;
export type ConfigInput = z.infer<typeof ConfigInputSchema>;
export type Ticket = z.infer<typeof TicketSchema>;
export type TicketPatch = z.infer<typeof TicketPatchSchema>;
export type Resources = z.infer<typeof ResourcesSchema>;
export function channelSlug(value: string): string {
    return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'ticket';
}
export function ticketChannelName(username: string, purpose: string): string {
    return `${channelSlug(username).slice(0, 32)}-${channelSlug(purpose).slice(0, 64)}`.slice(0, 100).replace(/-+$/g, '');
}
