import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits as P, type Guild, type GuildMember, type OverwriteResolvable } from 'discord.js';
import { z } from 'zod';
import { EmbedActorSchema, SnowflakeSchema } from '../embeds/contract.js';
import { getMemberRoleIds } from '../permissions/permissions.js';
import { getGuildChannels } from '../utilities/http.js';
import { destinationChannel } from '../embeds/publication.js';
import type { ConfigInput, Ticket, Resources } from './contract.js';

export const noMentions = { parse: [] as [], repliedUser: false };
export const missing = (e: unknown) => z.object({ code: z.union([z.literal(10003), z.literal(10008)]) }).safeParse(e).success;
export const actorFor = (member: GuildMember) => EmbedActorSchema.parse({ actor_user_id: member.id, actor_roles: getMemberRoleIds(member), actor_has_admin_permission: member.permissions.has(P.Administrator) });
export const systemActor = (guild: Guild) => EmbedActorSchema.parse({ actor_user_id: guild.client.user.id, actor_roles: [], actor_has_admin_permission: false });
export function ticketButton(action: 'create' | 'close', id: string) {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`ticket:${action}:${id}`)
        .setLabel(action === 'create' ? 'Create Ticket' : 'Close Ticket').setStyle(action === 'create' ? ButtonStyle.Primary : ButtonStyle.Danger));
}
export async function fetchChannel(guild: Guild, id: string) {
    try { return await guild.channels.fetch(SnowflakeSchema.parse(id), { force: true }); }
    catch (e) { if (missing(e)) return null; throw e; }
}
export async function ticketCategory(guild: Guild, id: string) {
    const c = await fetchChannel(guild, id);
    if (!c || c.guildId !== guild.id || c.type !== ChannelType.GuildCategory) throw new Error('The ticket category is missing or invalid. Ask staff to update this ticket configuration.');
    const bot = await guild.members.fetchMe();
    if (!c.permissionsFor(bot)?.has([P.ViewChannel, P.ManageChannels, P.ManageRoles])) throw new Error('I need View Channel, Manage Channels and Manage Roles in the ticket category.');
    return c;
}
export async function panelDestination(guild: Guild, id: string) {
    const c = await destinationChannel(guild, id);
    if (!c.permissionsFor(await guild.members.fetchMe())?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks, P.ReadMessageHistory])) throw new Error('I need View Channel, Send Messages, Embed Links and Read Message History in the panel channel.');
    return c;
}
export async function validateResources(guild: Guild, c: ConfigInput): Promise<Resources> {
    const panel = await panelDestination(guild, c.panel_channel_id);
    const category = await ticketCategory(guild, c.category_id);
    const roles = [];
    for (const id of c.staff_role_ids) {
        const role = await guild.roles.fetch(id);
        if (!role || role.guild.id !== guild.id || role.id === guild.id) throw new Error('Select existing staff roles from this server; @everyone is not staff.');
        roles.push({ id: role.id, guild_id: role.guild.id });
    }
    return { panel: { id: panel.id, guild_id: panel.guildId, type: 0 }, category: { id: category.id, guild_id: category.guildId, type: 4 }, roles };
}
export async function logDestination(guild: Guild) {
    const channels = z.object({ channels: z.record(SnowflakeSchema.nullable()) }).parse(await getGuildChannels(guild.id)).channels;
    if (!channels.bot_log) throw new Error('Staff must configure the bot_log channel with /setchannels before tickets can open.');
    const c = await panelDestination(guild, channels.bot_log);
    if (!c.permissionsFor(await guild.members.fetchMe())?.has([P.CreatePublicThreads, P.SendMessagesInThreads, P.ManageThreads])) throw new Error('I need Create Public Threads, Send Messages in Threads and Manage Threads in bot logs.');
    return c;
}
export async function privateOverwrites(guild: Guild, ticket: Ticket): Promise<OverwriteResolvable[]> {
    const access = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks, P.AddReactions, P.UseApplicationCommands];
    const overwrites: OverwriteResolvable[] = [
        { id: guild.id, type: 0, deny: [P.ViewChannel] },
        { id: ticket.user_id, type: 1, allow: access },
        { id: guild.client.user.id, type: 1, allow: [...access, P.ManageChannels, P.ManageRoles] },
    ];
    for (const id of ticket.staff_role_ids) {
        const role = await guild.roles.fetch(id);
        if (!role || role.guild.id !== guild.id || id === guild.id) throw new Error('A configured ticket staff role no longer exists. Ask staff to update ticket roles.');
        overwrites.push({ id, type: 0, allow: access });
    }
    return overwrites;
}
