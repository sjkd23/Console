// bot/src/commands/setroles.ts
import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    EmbedBuilder,
    MessageFlags,
    PermissionFlagsBits,
    GuildMember,
} from 'discord.js';
import type { SlashCommand } from '../_types.js';
import { setGuildRoles, BackendError } from '../../lib/utilities/http.js';
import { hasInternalRole, getMemberRoleIds, invalidateRoleCache } from '../../lib/permissions/permissions.js';
import { logCommandExecution, logConfigChange } from '../../lib/logging/bot-logger.js';

const ROLE_OPTIONS = [
    { key: 'administrator', label: 'Administrator', description: 'Full admin for bot actions' },
    { key: 'moderator', label: 'Moderator', description: 'Moderation actions' },
    { key: 'head_organizer', label: 'Head Organizer', description: 'Leads raid organization' },
    { key: 'officer', label: 'Officer', description: 'Senior staff' },
    { key: 'security', label: 'Security', description: 'Verification and security checks' },
    { key: 'organizer', label: 'Organizer', description: 'Runs and manages raids' },
    { key: 'team', label: 'Team', description: 'Auto-assigned to members with staff roles' },
    { key: 'verified_raider', label: 'Verified Raider', description: 'Verified community raider' },
    { key: 'suspended', label: 'Suspended', description: 'Temporarily suspended from raids' },
    { key: 'muted', label: 'Muted', description: 'Temporarily muted from sending messages' },
] as const;

export const setroles: SlashCommand = {
    requiredRole: undefined, // Uses Discord Administrator permission instead
    data: new SlashCommandBuilder()
        .setName('setroles')
        .setDescription('Configure internal role mappings for this server (Administrator)')
        .addRoleOption(o => o.setName('administrator').setDescription('Administrator role'))
        .addRoleOption(o => o.setName('moderator').setDescription('Moderator role'))
        .addRoleOption(o => o.setName('head_organizer').setDescription('Head Organizer role'))
        .addRoleOption(o => o.setName('officer').setDescription('Officer role'))
        .addRoleOption(o => o.setName('security').setDescription('Security role'))
        .addRoleOption(o => o.setName('organizer').setDescription('Organizer role'))
        .addRoleOption(o => o.setName('team').setDescription('Team role (auto-assigned to staff)'))
        .addRoleOption(o => o.setName('verified_raider').setDescription('Verified Raider role'))
        .addRoleOption(o => o.setName('suspended').setDescription('Suspended role'))
        .addRoleOption(o => o.setName('muted').setDescription('Muted role'))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .setDMPermission(false),

    async run(interaction: ChatInputCommandInteraction): Promise<void> {
        try {
            // 1) Guild-only check (reply immediately if invalid)
            if (!interaction.inGuild() || !interaction.guild) {
                await interaction.reply({
                    content: 'This command can only be used in a server.',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            // 2) Check Discord Administrator permission
            if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
                await interaction.reply({
                    content: '❌ **Access Denied**\n\nYou must have Discord **Administrator** permission to configure bot roles.',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            // 3) ACK ASAP to avoid 3s timeout
            await interaction.deferReply();

            // 4) Fetch member safely (needed for actor_roles)
            let member: GuildMember;
            try {
                member = await interaction.guild.members.fetch(interaction.user.id);
            } catch {
                await interaction.editReply('❌ Could not fetch your member record. Try again in a moment.');
                return;
            }

            // 5) Collect provided role updates (partial)
            const updates: Record<string, string | null> = {};
            for (const { key } of ROLE_OPTIONS) {
                // getRole returns Role | null when option omitted; only include if provided
                const role = interaction.options.getRole(key);
                if (role !== null) {
                    updates[key] = role ? role.id : null; // (null path included for future explicit clears)
                }
            }

            if (Object.keys(updates).length === 0) {
                await interaction.editReply('⚠️ No role updates provided. Pick at least one option.');
                return;
            }

            // 6) Backend call
            try {
                const { roles, warnings } = await setGuildRoles(interaction.guildId!, {
                    actor_user_id: interaction.user.id,
                    roles: updates,
                    actor_roles: getMemberRoleIds(member),
                    actor_has_admin_permission: interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false,
                });

                // Bust cache so future checks see new mapping
                invalidateRoleCache(interaction.guildId!);

                // 7) Build response
                const embed = new EmbedBuilder()
                    .setTitle('✅ Role configuration updated')
                    .setDescription('Current role mappings for this server:')
                    .setColor(0x00ff00)
                    .setTimestamp();

                for (const { key, label } of ROLE_OPTIONS) {
                    const discordRoleId = roles[key];
                    const value = discordRoleId ? `<@&${discordRoleId}>` : '—';
                    embed.addFields({ name: label, value, inline: true });
                }

                const warningText =
                    warnings && warnings.length > 0 ? `⚠️ **Warnings:**\n${warnings.map(w => `• ${w}`).join('\n')}` : undefined;

                await interaction.editReply({
                    content: warningText,
                    embeds: [embed],
                });

                // Log to bot-log
                const changes: Record<string, { old?: string; new?: string }> = {};
                for (const [key, newRoleId] of Object.entries(updates)) {
                    const label = ROLE_OPTIONS.find(r => r.key === key)?.label || key;
                    changes[label] = {
                        new: newRoleId ? `<@&${newRoleId}>` : 'Removed'
                    };
                }
                await logConfigChange(interaction.client, interaction.guildId!, 'Role Mappings', interaction.user.id, changes);
                await logCommandExecution(interaction.client, interaction, { success: true });
            } catch (err) {
                let msg = '❌ Failed to update roles. Please try again later.';
                if (err instanceof BackendError) {
                    if (err.code === 'NOT_AUTHORIZED') {
                        msg = '❌ **Access Denied**\n\nYou must have Discord **Administrator** permission to configure bot roles.\n\nMake sure you have the Administrator permission in this server\'s role settings.';
                    } else if (err.code === 'VALIDATION_ERROR') {
                        msg = `❌ Validation error: ${err.message}`;
                    }
                }
                await interaction.editReply(msg);
                await logCommandExecution(interaction.client, interaction, {
                    success: false,
                    errorMessage: msg
                });
            }
        } catch (unhandled) {
            // Catch any unexpected throw so the interaction is always answered
            try {
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply('❌ Something went wrong while handling this command.');
                } else {
                    await interaction.reply({ content: '❌ Something went wrong.', ephemeral: true });
                }
            } catch { }
            // Optional: log unhandled
            console.error('setroles unhandled error:', unhandled);
        }
    },
};
