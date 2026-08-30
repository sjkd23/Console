import { z } from 'zod';

interface OrganizerRoleMember {
    id: string;
    roles: { cache: ReadonlyMap<string, { id: string; position: number }> };
}

const RoleContextSchema = z.object({
    organizerRoles: z.array(z.string().regex(/^\d+$/)),
    organizerRolePositions: z.record(z.number().int().nonnegative()),
});

/** A failed fetch is not an empty roster. Callers must fail Start, not use actor roles. */
export async function fetchOrganizerStartContext(
    organizerId: string,
    fetchMember: (options: { user: string; force: true }) => Promise<OrganizerRoleMember>
) {
    const member = await fetchMember({ user: organizerId, force: true });
    if (member.id !== organizerId) throw new Error('Organizer role lookup returned a different member.');
    return RoleContextSchema.parse({
        organizerRoles: [...member.roles.cache.keys()],
        organizerRolePositions: Object.fromEntries([...member.roles.cache.values()].map(role => [role.id, role.position])),
    });
}
