// bot/src/commands/checkpunishments.ts
import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    MessageFlags,
    EmbedBuilder,
    time,
    TimestampStyles,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ButtonInteraction,
} from 'discord.js';
import type { SlashCommand } from '../../_types.js';
import { getUserPunishments, getUserNotes, BackendError } from '../../../lib/utilities/http.js';

/**
 * Create pagination buttons with mode toggle for checkpunishments
 */
function createCheckPunishmentsButtons(
    currentPage: number,
    totalPages: number,
    mode: 'punishments' | 'notes',
    hasNotes: boolean,
    hasPunishments: boolean,
    disabled = false
): ActionRowBuilder<ButtonBuilder>[] {
    const navigationRow = new ActionRowBuilder<ButtonBuilder>();

    navigationRow.addComponents(
        new ButtonBuilder()
            .setCustomId('cp_first')
            .setEmoji('⏮️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled || currentPage === 0 || totalPages === 0),
        new ButtonBuilder()
            .setCustomId('cp_prev')
            .setEmoji('◀️')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(disabled || currentPage === 0 || totalPages === 0),
        new ButtonBuilder()
            .setCustomId('cp_page')
            .setLabel(totalPages > 0 ? `${currentPage + 1} / ${totalPages}` : '0 / 0')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true),
        new ButtonBuilder()
            .setCustomId('cp_next')
            .setEmoji('▶️')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(disabled || currentPage === totalPages - 1 || totalPages === 0),
        new ButtonBuilder()
            .setCustomId('cp_last')
            .setEmoji('⏭️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled || currentPage === totalPages - 1 || totalPages === 0)
    );

    const toggleRow = new ActionRowBuilder<ButtonBuilder>();
    
    // Only show toggle if both punishments and notes exist
    if (hasPunishments && hasNotes) {
        toggleRow.addComponents(
            new ButtonBuilder()
                .setCustomId('cp_toggle')
                .setLabel(mode === 'punishments' ? 'View Notes' : 'View Punishments')
                .setStyle(ButtonStyle.Success)
                .setDisabled(disabled),
            new ButtonBuilder()
                .setCustomId('cp_stop')
                .setLabel('Stop')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(disabled)
        );
        return [navigationRow, toggleRow];
    }

    // If only one mode exists, still show stop button
    navigationRow.addComponents(
        new ButtonBuilder()
            .setCustomId('cp_stop')
            .setLabel('Stop')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(disabled)
    );

    return [navigationRow];
}

/**
 * Setup pagination with mode toggle for checkpunishments
 */
async function setupCheckPunishmentsPagination(
    interaction: ChatInputCommandInteraction,
    options: {
        punishmentEmbeds: EmbedBuilder[];
        noteEmbeds: EmbedBuilder[];
        userId: string;
        timeout?: number;
    }
): Promise<void> {
    const { punishmentEmbeds, noteEmbeds, userId, timeout = 600000 } = options;

    let mode: 'punishments' | 'notes' = 'punishments';
    let currentPage = 0;

    const hasPunishments = punishmentEmbeds.length > 0;
    const hasNotes = noteEmbeds.length > 0;

    // Start with whichever has content
    if (!hasPunishments && hasNotes) {
        mode = 'notes';
    }

    const getCurrentEmbeds = () => mode === 'punishments' ? punishmentEmbeds : noteEmbeds;
    const getTotalPages = () => getCurrentEmbeds().length;

    // Send initial message
    const currentEmbeds = getCurrentEmbeds();
    const totalPages = getTotalPages();

    if (totalPages === 0) {
        // This shouldn't happen as we check before calling this function
        return;
    }

    const message = await interaction.editReply({
        embeds: [currentEmbeds[currentPage]],
        components: createCheckPunishmentsButtons(currentPage, totalPages, mode, hasNotes, hasPunishments),
    });

    // Create collector for button interactions
    const collector = message.createMessageComponentCollector({
        filter: (i) => {
            // Only allow the user who invoked the command to use buttons
            if (i.user.id !== userId) {
                i.reply({
                    content: '❌ You cannot use these buttons. Use `/checkpunishments` to view your own results.',
                    ephemeral: true,
                }).catch(() => {});
                return false;
            }
            return i.customId.startsWith('cp_');
        },
        time: timeout,
    });

    collector.on('collect', async (buttonInteraction: ButtonInteraction) => {
        // Handle stop button - remove all buttons
        if (buttonInteraction.customId === 'cp_stop') {
            collector.stop('stopped');
            await buttonInteraction.update({
                components: [],
            });
            return;
        }

        let needsUpdate = false;

        // Handle mode toggle
        if (buttonInteraction.customId === 'cp_toggle') {
            mode = mode === 'punishments' ? 'notes' : 'punishments';
            currentPage = 0; // Reset to first page when switching modes
            needsUpdate = true;
        }
        // Handle navigation
        else {
            const totalPages = getTotalPages();
            
            switch (buttonInteraction.customId) {
                case 'cp_first':
                    if (currentPage !== 0) {
                        currentPage = 0;
                        needsUpdate = true;
                    }
                    break;
                case 'cp_prev':
                    if (currentPage > 0) {
                        currentPage = Math.max(0, currentPage - 1);
                        needsUpdate = true;
                    }
                    break;
                case 'cp_next':
                    if (currentPage < totalPages - 1) {
                        currentPage = Math.min(totalPages - 1, currentPage + 1);
                        needsUpdate = true;
                    }
                    break;
                case 'cp_last':
                    if (currentPage !== totalPages - 1) {
                        currentPage = totalPages - 1;
                        needsUpdate = true;
                    }
                    break;
            }
        }

        if (needsUpdate) {
            const currentEmbeds = getCurrentEmbeds();
            const totalPages = getTotalPages();

            // Update message with new page/mode
            await buttonInteraction.update({
                embeds: [currentEmbeds[currentPage]],
                components: createCheckPunishmentsButtons(currentPage, totalPages, mode, hasNotes, hasPunishments),
            });
        } else {
            // Acknowledge the interaction even if nothing changed
            await buttonInteraction.deferUpdate();
        }
    });

    collector.on('end', async (collected, reason) => {
        // Only disable buttons if timeout occurred (not if user clicked Stop)
        if (reason !== 'stopped') {
            try {
                const totalPages = getTotalPages();
                await interaction.editReply({
                    components: createCheckPunishmentsButtons(currentPage, totalPages, mode, hasNotes, hasPunishments, true),
                });
            } catch (err) {
                // Message might have been deleted
                console.warn('[CheckPunishments] Failed to disable buttons:', err);
            }
        }
    });
}


/**
 * /checkpunishments - View punishment history for a user
 * Moderator-only command with paginated embed navigation
 */
export const checkpunishments: SlashCommand = {
    requiredRole: 'security',
    data: new SlashCommandBuilder()
        .setName('checkpunishments')
        .setDescription('View punishment history for a member (Moderator only)')
        .addUserOption(option =>
            option
                .setName('member')
                .setDescription('The member to check punishments for')
                .setRequired(true)
        )
        .addBooleanOption(option =>
            option
                .setName('active_only')
                .setDescription('Show only active punishments (default: all)')
                .setRequired(false)
        )
        .setDMPermission(false),

    async run(interaction: ChatInputCommandInteraction) {
        try {
            // Guild-only check
            if (!interaction.guild || !interaction.guildId) {
                await interaction.reply({
                    content: 'This command can only be used in a server.',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            // Defer reply early
            await interaction.deferReply();

            // Get options
            const targetUser = interaction.options.getUser('member', true);
            const activeOnly = interaction.options.getBoolean('active_only') ?? false;

            try {
                // Fetch punishments from backend
                // Only pass activeOnly if it's explicitly true, otherwise get all punishments
                const result = await getUserPunishments(
                    interaction.guildId,
                    targetUser.id,
                    activeOnly ? true : undefined
                );

                const { punishments } = result;

                // Fetch notes for the user
                const notesResult = await getUserNotes(interaction.guildId, targetUser.id);
                const { notes } = notesResult;

                if (punishments.length === 0 && notes.length === 0) {
                    const embed = new EmbedBuilder()
                        .setTitle('📋 Punishment History')
                        .setDescription(`<@${targetUser.id}> has no ${activeOnly ? 'active ' : ''}punishments or notes on record.`)
                        .setColor(0x00ff00)
                        .setFooter({ text: `Requested by ${interaction.user.tag}` })
                        .setTimestamp();

                    await interaction.editReply({ embeds: [embed] });
                    return;
                }

                // Create one embed per punishment (newest first)
                const embeds = punishments.map((punishment, index) => {
                    const isWarn = punishment.type === 'warn';
                    const isSuspension = punishment.type === 'suspend';
                    const typeIcon = isWarn ? '⚠️' : '�';
                    const typeName = isWarn ? 'Warning' : 'Suspension';
                    
                    // Determine status for suspensions
                    let statusText = '';
                    let statusIcon = '';
                    let color = 0x3498db; // Default blue
                    
                    // Check if this was an extension (removal reason contains "Extended")
                    const isExtension = !punishment.active && 
                                       punishment.removal_reason && 
                                       punishment.removal_reason.includes('Extended');
                    
                    if (punishment.active) {
                        if (isSuspension && punishment.expires_at) {
                            const expiresAt = new Date(punishment.expires_at);
                            const now = new Date();
                            
                            if (expiresAt > now) {
                                // Still active and not expired
                                statusIcon = '🔴';
                                statusText = '**Currently Suspended**';
                                color = 0xff0000; // Red
                            } else {
                                // Should have been deactivated but wasn't yet
                                statusIcon = '🟠';
                                statusText = '**Expired (Not Yet Processed)**';
                                color = 0xffa500; // Orange
                            }
                        } else if (isWarn) {
                            // Warnings remain active forever
                            statusIcon = '🟡';
                            statusText = '**Active Warning**';
                            color = 0xffa500; // Orange
                        }
                    } else {
                        // Inactive punishment
                        if (isExtension) {
                            // This suspension was extended (not lifted)
                            statusIcon = '⏱️';
                            statusText = '**Extended to New Suspension**';
                            color = 0x3498db; // Blue
                        } else if (punishment.removed_at && punishment.removed_by) {
                            // Manually removed
                            statusIcon = '✅';
                            statusText = isWarn ? '**Warning Removed**' : '**Suspension Lifted**';
                            color = 0x2ecc71; // Green
                        } else if (isSuspension && punishment.expires_at) {
                            // Suspension expired naturally
                            statusIcon = '⏱️';
                            statusText = '**Suspension Expired**';
                            color = 0x95a5a6; // Gray
                        } else {
                            // Other inactive state
                            statusIcon = '⚫';
                            statusText = '**Inactive**';
                            color = 0x95a5a6; // Gray
                        }
                    }

                    const embed = new EmbedBuilder()
                        .setTitle(`${typeIcon} ${typeName}`)
                        .setDescription(`${statusIcon} ${statusText}\n\nPunishment for <@${targetUser.id}>`)
                        .setColor(color)
                        .addFields(
                            { 
                                name: 'Punishment ID', 
                                value: `\`${punishment.id}\``, 
                                inline: true 
                            },
                            { 
                                name: 'Type', 
                                value: typeName, 
                                inline: true 
                            },
                            { 
                                name: '\u200b', 
                                value: '\u200b', 
                                inline: true 
                            },
                            {
                                name: 'Issued By',
                                value: `<@${punishment.moderator_id}>`,
                                inline: true
                            },
                            {
                                name: 'Date Issued',
                                value: time(new Date(punishment.created_at), TimestampStyles.ShortDateTime),
                                inline: true
                            },
                            {
                                name: '\u200b',
                                value: '\u200b',
                                inline: true
                            }
                        );

                    // Add suspension timing information
                    if (isSuspension && punishment.expires_at) {
                        const expiresAt = new Date(punishment.expires_at);
                        const now = new Date();
                        const isExpired = expiresAt <= now;
                        
                        if (punishment.active && !isExpired) {
                            // Active suspension - show time remaining
                            const timeRemaining = expiresAt.getTime() - now.getTime();
                            const hoursRemaining = Math.ceil(timeRemaining / (1000 * 60 * 60));
                            const daysRemaining = Math.floor(hoursRemaining / 24);
                            
                            let remainingText = '';
                            if (daysRemaining > 0) {
                                remainingText = `${daysRemaining} day${daysRemaining !== 1 ? 's' : ''}, ${hoursRemaining % 24} hour${(hoursRemaining % 24) !== 1 ? 's' : ''}`;
                            } else {
                                remainingText = `${hoursRemaining} hour${hoursRemaining !== 1 ? 's' : ''}`;
                            }
                            
                            embed.addFields(
                                {
                                    name: '⏰ Time Remaining',
                                    value: `${remainingText}\n${time(expiresAt, TimestampStyles.RelativeTime)}`,
                                    inline: true
                                },
                                {
                                    name: 'Expires At',
                                    value: time(expiresAt, TimestampStyles.ShortDateTime),
                                    inline: true
                                },
                                {
                                    name: '\u200b',
                                    value: '\u200b',
                                    inline: true
                                }
                            );
                        } else if (isExpired) {
                            // Expired suspension - show when it ended
                            embed.addFields(
                                {
                                    name: '⏱️ Suspension Ended',
                                    value: `${time(expiresAt, TimestampStyles.ShortDateTime)}\n(${time(expiresAt, TimestampStyles.RelativeTime)})`,
                                    inline: true
                                },
                                {
                                    name: '\u200b',
                                    value: '\u200b',
                                    inline: true
                                },
                                {
                                    name: '\u200b',
                                    value: '\u200b',
                                    inline: true
                                }
                            );
                        }
                    }

                    // Add reason (full width)
                    embed.addFields({
                        name: 'Reason',
                        value: punishment.reason || 'No reason provided',
                        inline: false
                    });

                    // Add removal/extension information if manually removed
                    if (!punishment.active && punishment.removed_at && punishment.removed_by) {
                        if (isExtension) {
                            // This was extended, not removed
                            let extensionValue = `**When:** ${time(new Date(punishment.removed_at), TimestampStyles.ShortDateTime)} (${time(new Date(punishment.removed_at), TimestampStyles.RelativeTime)})\n`;
                            extensionValue += `**By:** <@${punishment.removed_by}>`;
                            
                            if (punishment.removal_reason) {
                                extensionValue += `\n**Details:** ${punishment.removal_reason}`;
                            }

                            embed.addFields({
                                name: '⏩ Suspension Extended',
                                value: extensionValue,
                                inline: false
                            });
                        } else {
                            // This was actually removed/lifted
                            const removalType = isWarn ? 'Warning Removed' : 'Suspension Lifted';
                            let removalValue = `**When:** ${time(new Date(punishment.removed_at), TimestampStyles.ShortDateTime)} (${time(new Date(punishment.removed_at), TimestampStyles.RelativeTime)})\n`;
                            removalValue += `**By:** <@${punishment.removed_by}>`;
                            
                            if (punishment.removal_reason) {
                                removalValue += `\n**Reason:** ${punishment.removal_reason}`;
                            }

                            embed.addFields({
                                name: `✅ ${removalType}`,
                                value: removalValue,
                                inline: false
                            });
                        }
                    }

                    // Footer with navigation info
                    const activeCount = punishments.filter(p => p.active).length;
                    const inactiveCount = punishments.length - activeCount;
                    let footerText = `Punishment ${index + 1} of ${punishments.length}`;
                    
                    if (!activeOnly) {
                        footerText += ` • Active: ${activeCount} | Inactive: ${inactiveCount}`;
                    }
                    
                    if (notes.length > 0) {
                        footerText += ` • ${notes.length} note${notes.length !== 1 ? 's' : ''}`;
                    }
                    
                    embed.setFooter({ text: footerText });
                    embed.setTimestamp(new Date(punishment.created_at));

                    return embed;
                });

                // Create embeds for notes
                const noteEmbeds = notes.map((note, index) => {
                    const embed = new EmbedBuilder()
                        .setTitle('📝 Staff Note')
                        .setDescription(`Note for <@${targetUser.id}>`)
                        .setColor(0x3498db) // Blue color for notes
                        .addFields(
                            { 
                                name: 'Note ID', 
                                value: `\`${note.id}\``, 
                                inline: true 
                            },
                            { 
                                name: '\u200b', 
                                value: '\u200b', 
                                inline: true 
                            },
                            { 
                                name: '\u200b', 
                                value: '\u200b', 
                                inline: true 
                            },
                            {
                                name: 'Added By',
                                value: `<@${note.moderator_id}>`,
                                inline: true
                            },
                            {
                                name: 'Date Added',
                                value: time(new Date(note.created_at), TimestampStyles.ShortDateTime),
                                inline: true
                            },
                            {
                                name: '\u200b',
                                value: '\u200b',
                                inline: true
                            }
                        );

                    // Add note text (full width)
                    embed.addFields({
                        name: 'Note',
                        value: note.note_text || 'No note provided',
                        inline: false
                    });

                    // Footer with navigation info
                    const totalItems = punishments.length + notes.length;
                    let footerText = `Note ${index + 1} of ${notes.length}`;
                    
                    if (punishments.length > 0) {
                        footerText += ` • ${punishments.length} punishment${punishments.length !== 1 ? 's' : ''}`;
                    }
                    
                    embed.setFooter({ text: footerText });
                    embed.setTimestamp(new Date(note.created_at));

                    return embed;
                });

                // Combine punishment embeds and note embeds
                const allEmbeds = [...embeds, ...noteEmbeds];

                // Setup custom pagination with mode toggle
                await setupCheckPunishmentsPagination(interaction, {
                    punishmentEmbeds: embeds,
                    noteEmbeds: noteEmbeds,
                    userId: interaction.user.id,
                    timeout: 600000, // 10 minutes
                });

            } catch (err) {
                let errorMessage = '❌ **Failed to retrieve punishments**\n\n';

                if (err instanceof BackendError) {
                    switch (err.code) {
                        case 'NOT_AUTHORIZED':
                            // This shouldn't happen since middleware already checked permissions
                            // But if it does, it's likely a backend configuration issue
                            errorMessage += '**Issue:** Authorization failed on the backend.\n\n';
                            errorMessage += '**What to do:**\n';
                            errorMessage += '• This is likely a server configuration issue\n';
                            errorMessage += '• Contact a server administrator if this persists';
                            break;
                        case 'VALIDATION_ERROR':
                            errorMessage += `**Issue:** ${err.message}\n\n`;
                            errorMessage += 'Please check your input and try again.';
                            break;
                        default:
                            errorMessage += `**Error:** ${err.message}\n\n`;
                            errorMessage += 'Please try again or contact an administrator if the problem persists.';
                    }
                } else {
                    console.error('[CheckPunishments] Unexpected error:', err);
                    errorMessage += 'An unexpected error occurred. Please try again later.';
                }

                await interaction.editReply(errorMessage);
            }
        } catch (unhandled) {
            try {
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply('❌ Something went wrong while handling this command.');
                } else {
                    await interaction.reply({ content: '❌ Something went wrong.', flags: MessageFlags.Ephemeral });
                }
            } catch { }
            console.error('[CheckPunishments] Unhandled error:', unhandled);
        }
    },
};
