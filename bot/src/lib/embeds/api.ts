import { z } from 'zod';
import { postJSON } from '../utilities/http.js';
import { EmbedActorSchema, EmbedConfigSchema, EmbedListSchema, EmbedNameSchema, SavedEmbedSchema, SnowflakeSchema, PublicationSchema, type EmbedPublication, type EmbedActor, type EmbedConfig } from './contract.js';

function base(guildId: string): string { return `/guilds/${SnowflakeSchema.parse(guildId)}/saved-embeds`; }
function item(guildId: string, id: string): string { return `${base(guildId)}/${z.string().uuid().parse(id)}`; }
const Response = z.object({ embed: SavedEmbedSchema });
export async function getSavedEmbed(guildId: string, id: string, actor: EmbedActor) {
    return Response.parse(await postJSON<unknown>(`${item(guildId, id)}/get`, EmbedActorSchema.parse(actor), { guildId })).embed;
}
export async function listSavedEmbeds(guildId: string, actor: EmbedActor, search = '', page = 0) {
    return EmbedListSchema.parse(await postJSON<unknown>(`${base(guildId)}/list`, { ...EmbedActorSchema.parse(actor), search, page }, { guildId }));
}
export async function saveEmbed(guildId: string, actor: EmbedActor, config: EmbedConfig, target: { id: string; revision: number } | { name: string }) {
    const payload = { ...EmbedActorSchema.parse(actor), config: EmbedConfigSchema.parse(config) };
    const response = 'id' in target
        ? await postJSON<unknown>(`${item(guildId, target.id)}/update`, { ...payload, revision: target.revision }, { guildId })
        : await postJSON<unknown>(`${base(guildId)}/create`, { ...payload, name: EmbedNameSchema.parse(target.name) }, { guildId });
    return Response.parse(response).embed;
}
export async function deleteSavedEmbed(guildId: string, id: string, revision: number, actor: EmbedActor): Promise<void> {
    z.object({ deleted: z.literal(true) }).parse(await postJSON<unknown>(`${item(guildId, id)}/delete`, { ...EmbedActorSchema.parse(actor), revision }, { guildId }));
}
export async function claimSavedEmbed(guildId: string, id: string, revision: number, actor: EmbedActor) {
    return Response.parse(await postJSON<unknown>(`${item(guildId, id)}/claim`, { ...EmbedActorSchema.parse(actor), revision }, { guildId })).embed;
}
export async function setEmbedPublication(guildId: string, id: string, revision: number, publication: EmbedPublication | null, actor: EmbedActor) {
    return Response.parse(await postJSON<unknown>(`${item(guildId, id)}/publication`, { ...EmbedActorSchema.parse(actor), revision, publication: PublicationSchema.nullable().parse(publication) }, { guildId })).embed;
}
