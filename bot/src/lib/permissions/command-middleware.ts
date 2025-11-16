// bot/src/lib/command-middleware.ts
import type { ChatInputCommandInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import type { SlashCommand } from '../../commands/_types.js';
import { hasInternalRole, hasRequiredRoleOrHigher, canBotManageMember, type RoleKey } from './permissions.js';

/**
 * Permission check result
 */
interface PermissionCheckResult {
    allowed: boolean;
    errorMessage?: string;
}

/**
 * Check if user has required role(s) for a command.
 * Returns detailed result with user-friendly error messages.
 * Now supports role hierarchy - users with higher roles can use lower-role commands.
 */
async function checkRequiredRole(
    interaction: ChatInputCommandInteraction,
    requiredRole: RoleKey | RoleKey[]
): Promise<PermissionCheckResult> {
    if (!interaction.guild) {
        return {
            allowed: false,
            errorMessage: 'This command can only be used in a server.'
        };
    }

    try {
        const member = await interaction.guild.members.fetch(interaction.user.id);
        const roles = Array.isArray(requiredRole) ? requiredRole : [requiredRole];

        // Check if user has any of the required roles (OR logic) with hierarchy support
        const roleChecks = await Promise.all(
            roles.map(role => hasRequiredRoleOrHigher(member, role))
        );

        // Check if any role check passed
        const hasAnyRole = roleChecks.some(check => check.hasRole);
        
        if (!hasAnyRole) {
            // Check if all required roles are not configured
            const allNotConfigured = roleChecks.every(check => !check.isConfigured);
            
            // Build friendly role list for error message
            const roleNames = roles.map(r => {
                // Convert role key to friendly name (e.g., 'moderator' -> 'Moderator', 'head_organizer' -> 'Head Organizer')
                return r.split('_').map(word =>
                    word.charAt(0).toUpperCase() + word.slice(1)
                ).join(' ');
            });

            const roleList = roleNames.length === 1
                ? `**${roleNames[0]}**`
                : roleNames.length === 2
                    ? `**${roleNames[0]}** or **${roleNames[1]}**`
                    : `**${roleNames.slice(0, -1).join('**, **')}**, or **${roleNames[roleNames.length - 1]}**`;

            if (allNotConfigured) {
                // All required roles are not configured in this guild
                return {
                    allowed: false,
                    errorMessage: `❌ **Role Not Configured**\n\nThe ${roleList} role is not configured for this server.\n\n**What to do:**\n• Ask a server admin to use \`/setroles\` to configure the required role\n• Once configured, make sure you have the Discord role that's mapped to it`
                };
            } else {
                // Roles are configured, but user doesn't have them
                return {
                    allowed: false,
                    errorMessage: `❌ **Missing Permission**\n\nYou need the ${roleList} role (or higher) to use this command.\n\n**What to do:**\n• Ask a server admin for the required role\n• Staff with higher roles (like Officers, Moderators, etc.) can also use this command`
                };
            }
        }

        return { allowed: true };
    } catch (err) {
        console.error('[CommandMiddleware] Failed to check required role:', err);
        return {
            allowed: false,
            errorMessage: '❌ Failed to verify your permissions. Please try again.'
        };
    }
}

/**
 * Check if bot can perform role mutations (if command requires it).
 * This is a preliminary check - actual target member checks should still be done in the command.
 */
async function checkBotRolePermissions(
    interaction: ChatInputCommandInteraction
): Promise<PermissionCheckResult> {
    if (!interaction.guild) {
        return {
            allowed: false,
            errorMessage: 'This command can only be used in a server.'
        };
    }

    try {
        const botMember = await interaction.guild.members.fetchMe();

        // Check if bot has Manage Roles permission
        if (!botMember.permissions.has('ManageRoles')) {
            return {
                allowed: false,
                errorMessage: '❌ **Bot Missing Permissions**\n\nThe bot lacks the "Manage Roles" permission.\n\n**What to do:**\n• Ask a server admin to grant the bot the "Manage Roles" permission\n• This is required for role assignment and removal operations'
            };
        }

        return { allowed: true };
    } catch (err) {
        console.error('[CommandMiddleware] Failed to check bot permissions:', err);
        return {
            allowed: false,
            errorMessage: '❌ Failed to verify bot permissions. Please try again.'
        };
    }
}

/**
 * Wraps a command with automatic permission and role position checking.
 * This is the main middleware function that enforces command-level requirements.
 */
export function withPermissionCheck(command: SlashCommand): SlashCommand {
    const originalRun = command.run;

    return {
        ...command,
        run: async (interaction: ChatInputCommandInteraction) => {
            // 1. Check required role (if specified)
            if (command.requiredRole) {
                const roleCheck = await checkRequiredRole(interaction, command.requiredRole);
                if (!roleCheck.allowed) {
                    await interaction.reply({
                        content: roleCheck.errorMessage,
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }
            }

            // 2. Check bot role permissions (if command mutates roles)
            if (command.mutatesRoles) {
                const botCheck = await checkBotRolePermissions(interaction);
                if (!botCheck.allowed) {
                    await interaction.reply({
                        content: botCheck.errorMessage,
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }
            }

            // 3. All checks passed - execute the command
            await originalRun(interaction);
        }
    };
}

/**
 * Helper to create a user-friendly error message for permission failures.
 * Can be used in commands for consistent error messaging.
 */
export function createPermissionErrorMessage(roleKey: RoleKey | RoleKey[], action: string): string {
    const roles = Array.isArray(roleKey) ? roleKey : [roleKey];
    const roleNames = roles.map(r =>
        r.split('_').map(word =>
            word.charAt(0).toUpperCase() + word.slice(1)
        ).join(' ')
    );

    const roleList = roleNames.length === 1
        ? `**${roleNames[0]}**`
        : roleNames.length === 2
            ? `**${roleNames[0]}** or **${roleNames[1]}**`
            : `**${roleNames.slice(0, -1).join('**, **')}**, or **${roleNames[roleNames.length - 1]}**`;

    return `❌ **Missing Permission**\n\nYou need the ${roleList} role to ${action}.\n\n**What to do:**\n• Ask a server admin to use \`/setroles\` to configure roles\n• Make sure you have the Discord role that's mapped to the required internal role`;
}
