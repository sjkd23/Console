import { z } from 'zod';
import { postJSON } from '../utilities/http.js';
import { EmbedActorSchema, SnowflakeSchema, type EmbedActor } from '../embeds/contract.js';
import { TicketConfigSchema, TicketSchema, type ConfigInput, type Resources, type TicketPatch } from './contract.js';

const ConfigResponse = z.object({ config: TicketConfigSchema });
const TicketResponse = z.object({ ticket: TicketSchema });
export async function request(guild: string, actor: EmbedActor, action: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    return postJSON<unknown>(`/guilds/${SnowflakeSchema.parse(guild)}/tickets/${action}`, { ...EmbedActorSchema.parse(actor), ...payload }, { guildId: guild });
}
export const getConfig = async (g: string, a: EmbedActor, id: string) => ConfigResponse.parse(await request(g, a, 'get', { id })).config;
export const listConfigs = async (g: string, a: EmbedActor, search = '', page = 0) => z.object({ configs: z.array(TicketConfigSchema), has_more: z.boolean() }).parse(await request(g, a, 'list', { search, page }));
export const saveConfig = async (g: string, a: EmbedActor, config: ConfigInput, resources: Resources, id?: string, revision?: number) => ConfigResponse.parse(await request(g, a, 'save', { config, resources, id, revision })).config;
export const manageConfig = async (g: string, a: EmbedActor, id: string, revision: number, action: 'claim' | 'disable' | 'publication', channel_id?: string, message_id?: string) => ConfigResponse.parse(await request(g, a, action, { id, revision, channel_id, message_id })).config;
export const reserve = async (g: string, a: EmbedActor, id: string, operation_id: string) => z.object({ won: z.boolean(), ticket: TicketSchema.nullable(), config: TicketConfigSchema }).parse(await request(g, a, 'reserve', { id, operation_id }));
export const getTicket = async (g: string, a: EmbedActor, id: string) => TicketResponse.parse(await request(g, a, 'ticket', { id })).ticket;
export const checkpoint = async (g: string, a: EmbedActor, id: string, operation_id: string, patch: TicketPatch) => TicketResponse.parse(await request(g, a, 'checkpoint', { id, operation_id, patch })).ticket;
export const close = async (g: string, a: EmbedActor, id: string, operation_id: string, recovery = false) => TicketResponse.parse(await request(g, a, recovery ? 'recover' : 'close', { id, operation_id })).ticket;
export const active = async (g: string, a: EmbedActor, after?: string) => z.object({ tickets: z.array(TicketSchema), next: z.string().uuid().nullable() }).parse(await request(g, a, 'active', { after }));
