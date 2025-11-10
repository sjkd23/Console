import type { GuildMember } from 'discord.js';

export function isOrganizer(member: GuildMember | null, organizerRoleId?: string) {
    if (!member || !organizerRoleId) return false;
    return member.roles.cache.has(organizerRoleId);
}
