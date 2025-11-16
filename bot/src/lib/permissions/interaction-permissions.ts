// bot/src/lib/interaction-permissions.ts
import type { ButtonInteraction, GuildMember } from 'discord.js';
import { hasInternalRole, hasRequiredRoleOrHigher } from './permissions.js';

/**
 * Check if user can access organizer panel or manage runs.
 * Returns detailed result with user-friendly error messages.
 * Now allows any user with organizer role or higher to access, with a warning if not the original organizer.
 */
export async function checkOrganizerAccess(
    interaction: ButtonInteraction,
    organizerId: string
): Promise<{ allowed: boolean; isOriginalOrganizer: boolean; errorMessage?: string; warningMessage?: string }> {
    if (!interaction.guild) {
        return {
            allowed: false,
            isOriginalOrganizer: false,
            errorMessage: 'This command can only be used in a server.'
        };
    }

    try {
        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        const isRunOrganizer = interaction.user.id === organizerId;
        
        // Use hierarchy-aware check - organizer or higher can access
        const roleCheck = await hasRequiredRoleOrHigher(member, 'organizer');
        
        // Allow if user has organizer role or higher
        if (!roleCheck.hasRole) {
            if (!roleCheck.isConfigured) {
                return {
                    allowed: false,
                    isOriginalOrganizer: false,
                    errorMessage: '❌ **Role Not Configured**\n\nThe **Organizer** role is not configured for this server.\n\n**What to do:**\n• Ask a server admin to use `/setroles` to configure the Organizer role\n• Once configured, make sure you have the Discord role that\'s mapped to it'
                };
            } else {
                return {
                    allowed: false,
                    isOriginalOrganizer: false,
                    errorMessage: '❌ **Access Denied**\n\nYou need the **Organizer** role (or higher) to access this panel.\n\n**What to do:**\n• Ask a server admin for the Organizer role\n• Staff with higher roles (like Officers, Security, etc.) can also access organizer panels'
                };
            }
        }

        // Generate warning if accessing someone else's panel
        let warningMessage: string | undefined;
        if (!isRunOrganizer) {
            warningMessage = `⚠️ **Note:** You are managing a raid organized by <@${organizerId}>.\n\nYou have access because you have the Organizer role or higher. Actions you take will be logged under your name.`;
        }

        return { 
            allowed: true, 
            isOriginalOrganizer: isRunOrganizer,
            warningMessage 
        };
    } catch (err) {
        console.error('[InteractionPermissions] Failed to check organizer access:', err);
        return {
            allowed: false,
            isOriginalOrganizer: false,
            errorMessage: '❌ Failed to verify your permissions. Please try again.'
        };
    }
}

/**
 * Reusable permission check for button interactions that require specific roles.
 * Supports role hierarchy - users with higher roles can access lower-role buttons.
 */
export async function checkButtonRoleAccess(
    interaction: ButtonInteraction,
    requiredRole: 'organizer' | 'moderator' | 'security' | 'officer' | 'administrator',
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
        
        // Use hierarchy-aware check
        const roleCheck = await hasRequiredRoleOrHigher(member, requiredRole);

        if (!roleCheck.hasRole) {
            const roleName = requiredRole.split('_').map(word =>
                word.charAt(0).toUpperCase() + word.slice(1)
            ).join(' ');
            
            if (!roleCheck.isConfigured) {
                return {
                    allowed: false,
                    member,
                    errorMessage: customErrorMessage || `❌ **Role Not Configured**\n\nThe **${roleName}** role is not configured for this server.\n\n**What to do:**\n• Ask a server admin to use \`/setroles\` to configure the ${roleName} role\n• Once configured, make sure you have the Discord role that's mapped to it`
                };
            } else {
                return {
                    allowed: false,
                    member,
                    errorMessage: customErrorMessage || `❌ **Missing Permission**\n\nYou need the **${roleName}** role (or higher) to perform this action.\n\n**What to do:**\n• Ask a server admin for the required role\n• Staff with higher roles can also perform this action`
                };
            }
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
