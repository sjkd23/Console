// bot/src/lib/interaction-permissions.ts
import type { ButtonInteraction, GuildMember } from 'discord.js';
import { hasInternalRole } from './permissions.js';

/**
 * Check if user can access organizer panel or manage runs.
 * Returns detailed result with user-friendly error messages.
 */
export async function checkOrganizerAccess(
    interaction: ButtonInteraction,
    organizerId: string
): Promise<{ allowed: boolean; errorMessage?: string }> {
    if (!interaction.guild) {
        return {
            allowed: false,
            errorMessage: 'This command can only be used in a server.'
        };
    }

    try {
        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        const isRunOrganizer = interaction.user.id === organizerId;
        const hasOrganizerRole = await hasInternalRole(member, 'organizer');

        if (!isRunOrganizer && !hasOrganizerRole) {
            return {
                allowed: false,
                errorMessage: '❌ **Access Denied**\n\nOnly the run organizer or users with the **Organizer** role can access this panel.\n\n**What to do:**\n• Ask a server admin to use `/setroles` to configure the Organizer role\n• Make sure you have the Discord role that\'s mapped to Organizer'
            };
        }

        return { allowed: true };
    } catch (err) {
        console.error('[InteractionPermissions] Failed to check organizer access:', err);
        return {
            allowed: false,
            errorMessage: '❌ Failed to verify your permissions. Please try again.'
        };
    }
}

/**
 * Reusable permission check for button interactions that require specific roles.
 */
export async function checkButtonRoleAccess(
    interaction: ButtonInteraction,
    requiredRole: 'organizer' | 'moderator' | 'security' | 'administrator',
    customErrorMessage?: string
): Promise<{ allowed: boolean; member: GuildMember | null; errorMessage?: string }> {
    if (!interaction.guild) {
        return {
            allowed: false,
            member: null,
            errorMessage: 'This command can only be used in a server.'
        };
    }

    try {
        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        const hasRole = await hasInternalRole(member, requiredRole);

        if (!hasRole) {
            const roleName = requiredRole.charAt(0).toUpperCase() + requiredRole.slice(1);
            return {
                allowed: false,
                member,
                errorMessage: customErrorMessage || `❌ **Missing Permission**\n\nYou need the **${roleName}** role to perform this action.\n\n**What to do:**\n• Ask a server admin to use \`/setroles\` to configure roles\n• Make sure you have the Discord role that's mapped to ${roleName}`
            };
        }

        return { allowed: true, member };
    } catch (err) {
        console.error('[InteractionPermissions] Failed to check role access:', err);
        return {
            allowed: false,
            member: null,
            errorMessage: '❌ Failed to verify your permissions. Please try again.'
        };
    }
}
