// bot/src/interactions/buttons/config/roleping-panel.ts
import {
    ButtonInteraction,
    MessageFlags,
    EmbedBuilder,
} from 'discord.js';
import { getDungeonRolePings } from '../../../lib/utilities/http.js';
import { DUNGEON_DATA } from '../../../constants/dungeons/DungeonData.js';
import { createLogger } from '../../../lib/logging/logger.js';

const logger = createLogger('RolePingPanel');

/**
 * Handle individual dungeon role toggle
 */
export async function handleRolePingToggle(
    interaction: ButtonInteraction,
    dungeonKey: string
): Promise<void> {
    try {
        // Defer the reply (ephemeral)
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (!interaction.guild || !interaction.member) {
            await interaction.editReply('This button can only be used in a server.');
            return;
        }

        // Get the role ID for this dungeon
        const { dungeon_role_pings } = await getDungeonRolePings(interaction.guildId!);
        const roleId = dungeon_role_pings[dungeonKey];

        if (!roleId) {
            await interaction.editReply('⚠️ This dungeon role ping is no longer configured.');
            return;
        }

        // Get the role
        const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
        if (!role) {
            await interaction.editReply('⚠️ The role for this dungeon no longer exists.');
            return;
        }

        // Get dungeon info
        const dungeon = DUNGEON_DATA.find(d => d.codeName === dungeonKey);
        const dungeonName = dungeon?.dungeonName || dungeonKey;

        // Check if member has the role
        const member = await interaction.guild.members.fetch(interaction.user.id);
        const hasRole = member.roles.cache.has(roleId);

        if (hasRole) {
            // Remove the role
            await member.roles.remove(roleId);
            await interaction.editReply(
                `✅ **Role Removed**\n\nYou will no longer be pinged for **${dungeonName}** raids.`
            );
            
            logger.info('Role ping removed', {
                guildId: interaction.guildId,
                userId: interaction.user.id,
                dungeonKey,
                roleId
            });
        } else {
            // Add the role
            await member.roles.add(roleId);
            await interaction.editReply(
                `✅ **Role Added**\n\nYou will now be pinged for **${dungeonName}** raids!`
            );
            
            logger.info('Role ping added', {
                guildId: interaction.guildId,
                userId: interaction.user.id,
                dungeonKey,
                roleId
            });
        }
    } catch (err) {
        logger.error('Failed to toggle role ping', {
            guildId: interaction.guildId,
            userId: interaction.user.id,
            dungeonKey,
            error: err instanceof Error ? err.message : String(err)
        });

        const errorMsg = '❌ Failed to toggle role. Please try again or contact an administrator.';
        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(errorMsg);
            } else {
                await interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral });
            }
        } catch { }
    }
}

/**
 * Handle "Add All Roles" button
 */
export async function handleRolePingAddAll(interaction: ButtonInteraction): Promise<void> {
    try {
        // Defer the reply (ephemeral)
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (!interaction.guild || !interaction.member) {
            await interaction.editReply('This button can only be used in a server.');
            return;
        }

        // Get all configured role pings
        const { dungeon_role_pings } = await getDungeonRolePings(interaction.guildId!);
        const roleIds = Object.values(dungeon_role_pings);

        if (roleIds.length === 0) {
            await interaction.editReply('⚠️ No dungeon role pings are configured.');
            return;
        }

        // Get member
        const member = await interaction.guild.members.fetch(interaction.user.id);

        // Filter to roles that exist and member doesn't have
        const rolesToAdd: string[] = [];
        for (const roleId of roleIds) {
            if (!member.roles.cache.has(roleId)) {
                const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
                if (role) {
                    rolesToAdd.push(roleId);
                }
            }
        }

        if (rolesToAdd.length === 0) {
            await interaction.editReply('✅ You already have all available dungeon role pings!');
            return;
        }

        // Add all roles
        await member.roles.add(rolesToAdd);

        await interaction.editReply(
            `✅ **All Roles Added**\n\nYou have been assigned **${rolesToAdd.length}** dungeon role ping(s)!`
        );

        logger.info('All role pings added', {
            guildId: interaction.guildId,
            userId: interaction.user.id,
            count: rolesToAdd.length
        });
    } catch (err) {
        logger.error('Failed to add all role pings', {
            guildId: interaction.guildId,
            userId: interaction.user.id,
            error: err instanceof Error ? err.message : String(err)
        });

        const errorMsg = '❌ Failed to add all roles. Please try again or contact an administrator.';
        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(errorMsg);
            } else {
                await interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral });
            }
        } catch { }
    }
}

/**
 * Handle "Remove All Roles" button
 */
export async function handleRolePingRemoveAll(interaction: ButtonInteraction): Promise<void> {
    try {
        // Defer the reply (ephemeral)
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (!interaction.guild || !interaction.member) {
            await interaction.editReply('This button can only be used in a server.');
            return;
        }

        // Get all configured role pings
        const { dungeon_role_pings } = await getDungeonRolePings(interaction.guildId!);
        const roleIds = Object.values(dungeon_role_pings);

        if (roleIds.length === 0) {
            await interaction.editReply('⚠️ No dungeon role pings are configured.');
            return;
        }

        // Get member
        const member = await interaction.guild.members.fetch(interaction.user.id);

        // Filter to roles that member has
        const rolesToRemove: string[] = [];
        for (const roleId of roleIds) {
            if (member.roles.cache.has(roleId)) {
                rolesToRemove.push(roleId);
            }
        }

        if (rolesToRemove.length === 0) {
            await interaction.editReply('✅ You don\'t have any dungeon role pings to remove!');
            return;
        }

        // Remove all roles
        await member.roles.remove(rolesToRemove);

        await interaction.editReply(
            `✅ **All Roles Removed**\n\n**${rolesToRemove.length}** dungeon role ping(s) have been removed.`
        );

        logger.info('All role pings removed', {
            guildId: interaction.guildId,
            userId: interaction.user.id,
            count: rolesToRemove.length
        });
    } catch (err) {
        logger.error('Failed to remove all role pings', {
            guildId: interaction.guildId,
            userId: interaction.user.id,
            error: err instanceof Error ? err.message : String(err)
        });

        const errorMsg = '❌ Failed to remove all roles. Please try again or contact an administrator.';
        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(errorMsg);
            } else {
                await interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral });
            }
        } catch { }
    }
}
