/**
 * Config command helpers to reduce massive duplication between setroles.ts and setchannels.ts
 * These two files are nearly identical 150+ line files with only role/channel differences
 */

import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    EmbedBuilder,
    MessageFlags,
    GuildMember,
} from 'discord.js';
import { setGuildRoles, setGuildChannels, BackendError } from './http.js';
import { getMemberRoleIds, invalidateRoleCache } from '../permissions/permissions.js';
import { logCommandExecution, logConfigChange } from '../logging/bot-logger.js';
import { fetchInvokerMember } from './member-helpers.js';

/**
 * Configuration option metadata
 */
export interface ConfigOption {
    key: string;
    label: string;
    description: string;
}

/**
 * Result from backend config update
 */
export interface ConfigUpdateResult {
    mapping: Record<string, string | null>;
    warnings?: string[];
}

/**
 * Generic handler for config commands (setroles, setchannels)
 * Eliminates 150+ lines of duplication per command
 */
export async function handleConfigCommand(
    interaction: ChatInputCommandInteraction,
    options: {
        configType: 'roles' | 'channels';
        configOptions: readonly ConfigOption[];
        backendUpdater: (guildId: string, data: any) => Promise<ConfigUpdateResult>;
        embedTitle: string;
        embedColor: number;
        invalidateCache?: (guildId: string) => void;
        formatValue: (value: string | null) => string;
        logLabel: string;
    }
): Promise<void> {
    try {
        // 1) Guild-only check (reply immediately if invalid)
        if (!interaction.inGuild() || !interaction.guild) {
            await interaction.reply({
                content: 'This command can only be used in a server.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        // 2) ACK ASAP to avoid 3s timeout (permission check done by middleware)
        await interaction.deferReply();

        // 3) Fetch member safely (needed for actor_roles)
        const member = await fetchInvokerMember(interaction);
        if (!member) {
            return; // Error already sent by helper
        }

        // 4) Collect provided updates (partial)
        const updates: Record<string, string | null> = {};
        for (const { key } of options.configOptions) {
            const value = options.configType === 'roles'
                ? interaction.options.getRole(key)
                : interaction.options.getChannel(key);
            
            if (value !== null) {
                updates[key] = value ? value.id : null;
            }
        }

        if (Object.keys(updates).length === 0) {
            await interaction.editReply(`⚠️ No ${options.configType} updates provided. Pick at least one option.`);
            return;
        }

        // 5) Backend call
        try {
            const result = await options.backendUpdater(interaction.guildId!, {
                actor_user_id: interaction.user.id,
                [options.configType]: updates,
                actor_roles: getMemberRoleIds(member),
            });

            const { mapping, warnings } = result;

            // Bust cache if provided (for roles)
            if (options.invalidateCache) {
                options.invalidateCache(interaction.guildId!);
            }

            // 6) Build response
            const embed = new EmbedBuilder()
                .setTitle(options.embedTitle)
                .setDescription(`Current ${options.configType} mappings for this server:`)
                .setColor(options.embedColor)
                .setTimestamp();

            for (const { key, label } of options.configOptions) {
                const value = options.formatValue(mapping[key]);
                embed.addFields({ name: label, value, inline: true });
            }

            const warningText =
                warnings && warnings.length > 0 
                    ? `⚠️ **Warnings:**\n${warnings.map(w => `• ${w}`).join('\n')}` 
                    : undefined;

            await interaction.editReply({
                content: warningText,
                embeds: [embed],
            });

            // Log to bot-log
            const changes: Record<string, { old?: string; new?: string }> = {};
            for (const [key, newValue] of Object.entries(updates)) {
                const label = options.configOptions.find(r => r.key === key)?.label || key;
                changes[label] = {
                    new: options.formatValue(newValue)
                };
            }
            await logConfigChange(interaction.client, interaction.guildId!, options.logLabel, interaction.user.id, changes);
            await logCommandExecution(interaction.client, interaction, { success: true });
        } catch (err) {
            let msg = `❌ Failed to update ${options.configType}. Please try again later.`;
            if (err instanceof BackendError) {
                if (err.code === 'NOT_AUTHORIZED') {
                    msg = `❌ **Access Denied**\n\nYou must have Discord **Administrator** permission to configure bot ${options.configType}.\n\nMake sure you have the Administrator permission in this server\'s role settings.`;
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
        console.error(`${options.configType} command unhandled error:`, unhandled);
    }
}

/**
 * Format role value for display
 */
export function formatRoleValue(roleId: string | null): string {
    return roleId ? `<@&${roleId}>` : '—';
}

/**
 * Format channel value for display
 */
export function formatChannelValue(channelId: string | null): string {
    return channelId ? `<#${channelId}>` : '—';
}
