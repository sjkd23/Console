// bot/src/commands/moderation/administrator/forcesync.ts
import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    EmbedBuilder,
    MessageFlags,
} from 'discord.js';
import type { SlashCommand } from '../../_types.js';
import { ensureGuildContext } from '../../../lib/utilities/interaction-helpers.js';
import { formatErrorMessage } from '../../../lib/errors/error-handler.js';
import { getGuildRoles, bulkSyncMembers } from '../../../lib/utilities/http.js';
import { getMemberRoleIds } from '../../../lib/permissions/permissions.js';
import { createProgressBarWithPercentage } from '../../../lib/utilities/progress-bar.js';
import { logCommandExecution } from '../../../lib/logging/bot-logger.js';

/**
 * Module-level flag to ensure only one instance runs at a time
 */
let isRunning = false;

/**
 * Extract main and alt IGNs from a member's nickname
 * Follows the same pattern as /addalt command: "MainIgn | AltIgn"
 * 
 * Examples:
 * - "MyIgn" -> { main: "MyIgn", alt: undefined }
 * - "MainIgn | AltIgn" -> { main: "MainIgn", alt: "AltIgn" }
 * - "IGN1 / IGN2" -> { main: "IGN1", alt: "IGN2" }
 * - "A | B | C" -> { main: "A", alt: "B" } (only uses first two)
 * 
 * @param nickname The member's server nickname
 * @returns Object with main IGN and optional alt IGN
 */
function parseIgnsFromNickname(nickname: string | null): { main: string; alt?: string } | null {
    if (!nickname) return null;
    
    // Split on common delimiters: |, /, \
    const parts = nickname
        .split(/[|/\\]/)
        .map(s => s.trim())
        .filter(s => s.length > 0 && s.length <= 16); // Filter valid IGN lengths
    
    if (parts.length === 0) {
        return null;
    }
    
    // First part is main IGN, second part (if exists) is alt IGN
    return {
        main: parts[0],
        alt: parts.length > 1 ? parts[1] : undefined,
    };
}

/**
 * Format duration in milliseconds to human-readable string
 */
function formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    
    if (minutes > 0) {
        return `${minutes}m ${remainingSeconds}s`;
    }
    return `${seconds}s`;
}

/**
 * /forcesync - Force-sync all verified members in this server with the database
 * 
 * This command:
 * 1. Fetches all guild members with the verified_raider or suspended role
 * 2. Extracts IGNs from their nicknames:
 *    - "MainIgn" -> main IGN only
 *    - "MainIgn | AltIgn" -> main IGN + alt IGN (follows /addalt pattern)
 * 3. Syncs those IGNs with the database via bulk sync endpoint
 * 4. Shows live progress updates during execution
 * 
 * Only one instance can run at a time (per bot process).
 * Restricted to Administrator role.
 */
export const forcesync: SlashCommand = {
    requiredRole: 'administrator',
    data: new SlashCommandBuilder()
        .setName('forcesync')
        .setDescription('Force-sync all verified members in this server with the database (Administrator)')
        .setDMPermission(false),

    async run(interaction: ChatInputCommandInteraction) {
        // Guild-only check (should already be enforced by DMPermission but double-check)
        const guild = await ensureGuildContext(interaction);
        if (!guild) return;

        // Check if command is already running
        if (isRunning) {
            await interaction.reply({
                content: '⏸️ This command is currently running. Please wait for it to finish before running it again.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        // Set running flag
        isRunning = true;

        // Track start time
        const startTime = Date.now();

        try {
            // Send initial reply
            const initialEmbed = new EmbedBuilder()
                .setTitle('🔄 Force Sync')
                .setDescription('⏳ Preparing to sync...\n\nFetching guild members and role configuration...')
                .setColor(0x5865F2)
                .setTimestamp();

            await interaction.reply({ embeds: [initialEmbed] });

            // Get guild role mappings
            const { roles: roleMap } = await getGuildRoles(guild.id);
            const verifiedRaiderRoleId = roleMap.verified_raider;
            const suspendedRoleId = roleMap.suspended;

            if (!verifiedRaiderRoleId) {
                await interaction.editReply({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle('❌ Configuration Error')
                            .setDescription(
                                'Verified Raider role is not configured for this server.\n\n' +
                                'Please ask a Moderator to configure it using `/setroles`.'
                            )
                            .setColor(0xFF0000)
                            .setTimestamp()
                    ]
                });
                return;
            }

            // Update: Fetching members
            await interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('🔄 Force Sync')
                        .setDescription('⏳ Fetching all guild members...\n\nThis may take a moment for large servers.')
                        .setColor(0x5865F2)
                        .setTimestamp()
                ]
            });

            // Fetch members if cache is incomplete (less than 95% of total members)
            // This prevents unnecessary fetches while ensuring we have recent data
            const cacheCompleteness = guild.members.cache.size / guild.memberCount;
            if (cacheCompleteness < 0.95) {
                console.log(`[ForceSync] Fetching members (cache: ${guild.members.cache.size}/${guild.memberCount} = ${(cacheCompleteness * 100).toFixed(1)}%)`);
                try {
                    await guild.members.fetch({ time: 30000 }); // 30 second timeout
                    console.log(`[ForceSync] Fetched members (new cache size: ${guild.members.cache.size})`);
                } catch (error) {
                    // If fetch fails, try to use cached members
                    console.error(`[ForceSync] Failed to fetch members, using cache:`, error);
                    if (guild.members.cache.size === 0) {
                        // If cache is empty and fetch failed, we can't proceed
                        throw error;
                    }
                    // Otherwise continue with cached data
                }
            } else {
                console.log(`[ForceSync] Using cached members (${guild.members.cache.size}/${guild.memberCount} = ${(cacheCompleteness * 100).toFixed(1)}%)`);
            }

            // Filter to verified or suspended members with nicknames
            const membersWithRole = guild.members.cache.filter(member => {
                // Must have verified_raider or suspended role
                return member.roles.cache.has(verifiedRaiderRoleId) ||
                    (suspendedRoleId && member.roles.cache.has(suspendedRoleId));
            });

            const targetMembers = membersWithRole.filter(member => {
                // Must have a nickname
                return !!member.nickname;
            });

            console.log(`[ForceSync] Found ${membersWithRole.size} members with verified role, ${targetMembers.size} have nicknames`);

            const totalMembers = targetMembers.size;

            if (totalMembers === 0) {
                const withoutNicknames = membersWithRole.size - targetMembers.size;
                await interaction.editReply({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle('ℹ️ No Members to Sync')
                            .setDescription(
                                'No members found with the Verified Raider role and a nickname.\n\n' +
                                `**${membersWithRole.size}** members have the Verified Raider role\n` +
                                `**${withoutNicknames}** of them lack a server nickname\n\n` +
                                'Members must have:\n' +
                                '• Verified Raider or Suspended role\n' +
                                '• A server nickname set (for IGN extraction)'
                            )
                            .setColor(0xFFA500)
                            .setTimestamp()
                    ]
                });
                return;
            }

            // Prepare member data for bulk sync
            const memberData: Array<{ user_id: string; main_ign: string; alt_ign?: string }> = [];
            
            for (const member of targetMembers.values()) {
                const parsed = parseIgnsFromNickname(member.nickname);
                if (parsed) {
                    memberData.push({
                        user_id: member.id,
                        main_ign: parsed.main,
                        alt_ign: parsed.alt,
                    });
                }
            }

            // Progress tracking
            let processed = 0;
            let synced = 0;
            let skipped = 0;
            let failed = 0;

            const BATCH_SIZE = 250; // Process 250 members per batch
            const batches: typeof memberData[] = [];
            
            // Split into batches
            for (let i = 0; i < memberData.length; i += BATCH_SIZE) {
                batches.push(memberData.slice(i, i + BATCH_SIZE));
            }

            // Create progress embed builder
            const createProgressEmbed = () => {
                const progress = processed / totalMembers;
                const progressBar = createProgressBarWithPercentage(20, progress);
                
                return new EmbedBuilder()
                    .setTitle('🔄 Force Sync - In Progress')
                    .setDescription(
                        `Processing members...\n\n` +
                        `${progressBar}\n\n` +
                        `**Progress:** ${processed} / ${totalMembers} members`
                    )
                    .addFields(
                        { name: '✅ Synced', value: synced.toString(), inline: true },
                        { name: '⏭️ Skipped', value: skipped.toString(), inline: true },
                        { name: '❌ Failed', value: failed.toString(), inline: true }
                    )
                    .setColor(0x5865F2)
                    .setFooter({ text: 'This may take a while for large servers...' })
                    .setTimestamp();
            };

            // Update embed every 3 seconds
            let lastUpdateTime = Date.now();
            const UPDATE_INTERVAL = 3000; // 3 seconds

            // Process batches
            for (const batch of batches) {
                try {
                    // Get actor's role IDs and check for Discord Administrator permission
                    const actorMember = await guild.members.fetch(interaction.user.id);
                    const actorRoles = getMemberRoleIds(actorMember);
                    const hasAdminPermission = actorMember.permissions.has('Administrator');

                    // Call bulk sync endpoint
                    const result = await bulkSyncMembers(guild.id, {
                        actor_user_id: interaction.user.id,
                        actor_roles: actorRoles,
                        actor_has_admin_permission: hasAdminPermission,
                        members: batch,
                    });

                    // Update counters
                    synced += result.synced.length;
                    skipped += result.skipped.length;
                    failed += result.failed.length;
                    processed += batch.length;

                    // Update embed if enough time has passed
                    const now = Date.now();
                    if (now - lastUpdateTime >= UPDATE_INTERVAL) {
                        await interaction.editReply({ embeds: [createProgressEmbed()] });
                        lastUpdateTime = now;
                    }
                } catch (err) {
                    console.error('[ForceSync] Batch processing error:', err);
                    // Mark entire batch as failed
                    failed += batch.length;
                    processed += batch.length;
                }
            }

            // Calculate duration
            const duration = Date.now() - startTime;

            // Build description based on results
            let description = 'Successfully processed all members!\n\n';
            description += `${createProgressBarWithPercentage(20, 1)}\n\n`;
            description += `**Total Processed:** ${totalMembers} members`;
            
            // Add note if there were members with role but no nickname
            const withoutNicknames = membersWithRole.size - targetMembers.size;
            if (withoutNicknames > 0) {
                description += `\n\n⚠️ **Note:** ${withoutNicknames} member${withoutNicknames === 1 ? '' : 's'} with the Verified Raider role lack${withoutNicknames === 1 ? 's' : ''} a server nickname and could not be processed.`;
            }

            // Send final completion embed
            const completionEmbed = new EmbedBuilder()
                .setTitle('✅ Force Sync - Completed')
                .setDescription(description)
                .addFields(
                    { name: '✅ Synced', value: synced.toString(), inline: true },
                    { name: '⏭️ Skipped', value: skipped.toString(), inline: true },
                    { name: '❌ Failed', value: failed.toString(), inline: true },
                    { name: '⏱️ Duration', value: formatDuration(duration), inline: false }
                )
                .setColor(0x00FF00)
                .setTimestamp();

            await interaction.editReply({ embeds: [completionEmbed] });

            // Log to bot-log
            await logCommandExecution(interaction.client, interaction, {
                success: true,
                details: {
                    'Total Processed': totalMembers.toString(),
                    'Synced': synced.toString(),
                    'Skipped': skipped.toString(),
                    'Failed': failed.toString(),
                    'Duration': formatDuration(duration),
                }
            });

        } catch (error) {
            console.error('[ForceSync] Command error:', error);
            
            const errorMessage = formatErrorMessage({
                error,
                baseMessage: 'Failed to complete force sync',
            });

            await interaction.editReply(errorMessage);

            // Log error to bot-log
            await logCommandExecution(interaction.client, interaction, {
                success: false,
                errorMessage: error instanceof Error ? error.message : 'Unknown error',
            });
        } finally {
            // Always clear the running flag
            isRunning = false;
        }
    },
};
