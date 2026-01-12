// bot/src/commands/find.ts
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
import { getUserPunishments, getUserNotes, getRaider, BackendError } from '../../../lib/utilities/http.js';

type TabMode = 'userinfo' | 'punishments' | 'notes';

/**
 * Create tab navigation buttons for find command
 */
function createFindButtons(
    mode: TabMode,
    hasNotes: boolean,
    hasPunishments: boolean,
    currentPage: number,
    totalPages: number,
    disabled = false
): ActionRowBuilder<ButtonBuilder>[] {
    const tabRow = new ActionRowBuilder<ButtonBuilder>();
    
    // Tab buttons
    tabRow.addComponents(
        new ButtonBuilder()
            .setCustomId('find_tab_userinfo')
            .setLabel('User Info')
            .setStyle(mode === 'userinfo' ? ButtonStyle.Primary : ButtonStyle.Secondary)
            .setDisabled(disabled || mode === 'userinfo'),
        new ButtonBuilder()
            .setCustomId('find_tab_punishments')
            .setLabel('Punishments')
            .setStyle(mode === 'punishments' ? ButtonStyle.Primary : ButtonStyle.Secondary)
            .setDisabled(disabled || mode === 'punishments' || !hasPunishments),
        new ButtonBuilder()
            .setCustomId('find_tab_notes')
            .setLabel('Notes')
            .setStyle(mode === 'notes' ? ButtonStyle.Primary : ButtonStyle.Secondary)
            .setDisabled(disabled || mode === 'notes' || !hasNotes)
    );

    // If we're in userinfo mode, no pagination needed
    if (mode === 'userinfo') {
        return [tabRow];
    }

    // For punishments/notes, add pagination
    const navigationRow = new ActionRowBuilder<ButtonBuilder>();
    navigationRow.addComponents(
        new ButtonBuilder()
            .setCustomId('find_first')
            .setEmoji('⏮️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled || currentPage === 0 || totalPages === 0),
        new ButtonBuilder()
            .setCustomId('find_prev')
            .setEmoji('◀️')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(disabled || currentPage === 0 || totalPages === 0),
        new ButtonBuilder()
            .setCustomId('find_page')
            .setLabel(totalPages > 0 ? `${currentPage + 1} / ${totalPages}` : '0 / 0')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true),
        new ButtonBuilder()
            .setCustomId('find_next')
            .setEmoji('▶️')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(disabled || currentPage === totalPages - 1 || totalPages === 0),
        new ButtonBuilder()
            .setCustomId('find_last')
            .setEmoji('⏭️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled || currentPage === totalPages - 1 || totalPages === 0)
    );

    return [tabRow, navigationRow];
}

/**
 * Create the User Info embed
 */
async function createUserInfoEmbed(
    interaction: ChatInputCommandInteraction,
    targetUser: { id: string; username: string; displayAvatarURL: (options?: any) => string },
    raiderData: Awaited<ReturnType<typeof getRaider>>,
    hasPunishments: boolean,
    hasNotes: boolean
): Promise<EmbedBuilder> {
    // Get guild member to check for nickname and roles
    const member = await interaction.guild!.members.fetch(targetUser.id).catch(() => null);
    
    // Get server nickname (or username if no nickname)
    const displayName = member?.displayName || targetUser.username;
    
    // Get highest role (exclude @everyone)
    const roles = member?.roles.cache.filter(r => r.id !== interaction.guildId).sort((a, b) => b.position - a.position);
    const highestRole = roles?.first();
    
    // Check if user has an active suspension
    let isSuspended = false;
    try {
        const { punishments } = await getUserPunishments(
            interaction.guildId!,
            targetUser.id,
            true // active only
        );
        isSuspended = punishments.some(p => p.type === 'suspend' && p.active);
    } catch {
        // If we can't check, assume not suspended
    }

    const embed = new EmbedBuilder()
        .setTitle(`Find Query Success: ${raiderData?.ign || 'Not Verified'}`)
        .setColor(0x3498db)
        .setThumbnail(targetUser.displayAvatarURL({ size: 128 }));

    // Build description
    let description = `**${displayName}**\n\n`;
    
    if (raiderData) {
        description += `Found <@${targetUser.id}> with IGN(s): **${raiderData.ign}**`;
        if (raiderData.alt_ign) {
            description += `, **${raiderData.alt_ign}**`;
        }
        description += '\n';
    } else {
        description += `Found <@${targetUser.id}> - **Not Verified**\n`;
    }
    
    description += `Suspended: ${isSuspended ? '✅' : '❌'}\n\n`;
    
    if (highestRole) {
        description += `**Highest Role**\n<@&${highestRole.id}>`;
    } else {
        description += `**Highest Role**\nNone`;
    }

    embed.setDescription(description);
    
    // Add footer with additional info
    let footerText = '';
    if (hasPunishments) {
        footerText += 'Has punishments';
    }
    if (hasNotes) {
        footerText += hasPunishments ? ' • Has notes' : 'Has notes';
    }
    if (footerText) {
        embed.setFooter({ text: footerText });
    }
    
    embed.setTimestamp();

    return embed;
}

/**
 * Setup tab navigation with pagination for find command
 */
async function setupFindNavigation(
    interaction: ChatInputCommandInteraction,
    options: {
        targetUser: { id: string; username: string; displayAvatarURL: (options?: any) => string };
        raiderData: Awaited<ReturnType<typeof getRaider>>;
        punishmentEmbeds: EmbedBuilder[];
        noteEmbeds: EmbedBuilder[];
        userId: string;
        timeout?: number;
    }
): Promise<void> {
    const { targetUser, raiderData, punishmentEmbeds, noteEmbeds, userId, timeout = 1800000 } = options;

    let mode: TabMode = 'userinfo';
    let currentPage = 0;

    const hasPunishments = punishmentEmbeds.length > 0;
    const hasNotes = noteEmbeds.length > 0;

    const getCurrentEmbeds = () => {
        if (mode === 'userinfo') return [];
        return mode === 'punishments' ? punishmentEmbeds : noteEmbeds;
    };
    const getTotalPages = () => getCurrentEmbeds().length;

    // Create initial user info embed
    const userInfoEmbed = await createUserInfoEmbed(
        interaction,
        targetUser,
        raiderData,
        hasPunishments,
        hasNotes
    );

    // Send initial message (User Info tab)
    const message = await interaction.editReply({
        embeds: [userInfoEmbed],
        components: createFindButtons(mode, hasNotes, hasPunishments, 0, 0),
    });

    // Create collector for button interactions
    const collector = message.createMessageComponentCollector({
        filter: (i) => {
            // Only allow the user who invoked the command to use buttons
            if (i.user.id !== userId) {
                i.reply({
                    content: '❌ You cannot use these buttons. Use `/find` to view your own results.',
                    ephemeral: true,
                }).catch(() => {});
                return false;
            }
            return i.customId.startsWith('find_');
        },
        time: timeout,
    });

    collector.on('collect', async (buttonInteraction: ButtonInteraction) => {

        let needsUpdate = false;

        // Handle tab switches
        if (buttonInteraction.customId === 'find_tab_userinfo') {
            if (mode !== 'userinfo') {
                mode = 'userinfo';
                currentPage = 0;
                needsUpdate = true;
            }
        } else if (buttonInteraction.customId === 'find_tab_punishments') {
            if (mode !== 'punishments') {
                mode = 'punishments';
                currentPage = 0;
                needsUpdate = true;
            }
        } else if (buttonInteraction.customId === 'find_tab_notes') {
            if (mode !== 'notes') {
                mode = 'notes';
                currentPage = 0;
                needsUpdate = true;
            }
        }
        // Handle navigation (only for punishments/notes tabs)
        else if (mode !== 'userinfo') {
            const totalPages = getTotalPages();
            
            switch (buttonInteraction.customId) {
                case 'find_first':
                    if (currentPage !== 0) {
                        currentPage = 0;
                        needsUpdate = true;
                    }
                    break;
                case 'find_prev':
                    if (currentPage > 0) {
                        currentPage = Math.max(0, currentPage - 1);
                        needsUpdate = true;
                    }
                    break;
                case 'find_next':
                    if (currentPage < totalPages - 1) {
                        currentPage = Math.min(totalPages - 1, currentPage + 1);
                        needsUpdate = true;
                    }
                    break;
                case 'find_last':
                    if (currentPage !== totalPages - 1) {
                        currentPage = totalPages - 1;
                        needsUpdate = true;
                    }
                    break;
            }
        }

        if (needsUpdate) {
            let embedToShow: EmbedBuilder;
            
            if (mode === 'userinfo') {
                embedToShow = await createUserInfoEmbed(
                    interaction,
                    targetUser,
                    raiderData,
                    hasPunishments,
                    hasNotes
                );
            } else {
                const currentEmbeds = getCurrentEmbeds();
                embedToShow = currentEmbeds[currentPage];
            }

            const totalPages = getTotalPages();

            // Update message with new tab/page
            await buttonInteraction.update({
                embeds: [embedToShow],
                components: createFindButtons(mode, hasNotes, hasPunishments, currentPage, totalPages),
            });
        } else {
            // Acknowledge the interaction even if nothing changed
            await buttonInteraction.deferUpdate();
        }
    });

    collector.on('end', async () => {
        // Disable buttons when collector expires
        try {
            const totalPages = getTotalPages();
            await interaction.editReply({
                components: createFindButtons(mode, hasNotes, hasPunishments, currentPage, totalPages, true),
            });
        } catch (err) {
            // Message might have been deleted
            console.warn('[Find] Failed to disable buttons:', err);
        }
    });
}


/**
 * /find - Find and view detailed information about a user
 * Security+ command with user info, punishment history, and notes
 */
export const find: SlashCommand = {
    requiredRole: 'security',
    data: new SlashCommandBuilder()
        .setName('find')
        .setDescription('Find and view detailed information about a member (Security+ only)')
        .addUserOption(option =>
            option
                .setName('member')
                .setDescription('The member to find')
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
                // Fetch raider data
                const raiderData = await getRaider(interaction.guildId, targetUser.id);

                // Fetch punishments from backend
                const result = await getUserPunishments(
                    interaction.guildId,
                    targetUser.id,
                    activeOnly ? true : undefined
                );

                const { punishments } = result;

                // Fetch notes for the user
                const notesResult = await getUserNotes(interaction.guildId, targetUser.id);
                const { notes } = notesResult;

                // Create one embed per punishment (newest first)
                const punishmentEmbeds = punishments.map((punishment, index) => {
                    const isWarn = punishment.type === 'warn';
                    const isSuspension = punishment.type === 'suspend';
                    const typeIcon = isWarn ? '⚠️' : '🔨';
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
                    let footerText = `Note ${index + 1} of ${notes.length}`;
                    
                    if (punishments.length > 0) {
                        footerText += ` • ${punishments.length} punishment${punishments.length !== 1 ? 's' : ''}`;
                    }
                    
                    embed.setFooter({ text: footerText });
                    embed.setTimestamp(new Date(note.created_at));

                    return embed;
                });

                // Setup tab navigation
                await setupFindNavigation(interaction, {
                    targetUser: targetUser,
                    raiderData: raiderData,
                    punishmentEmbeds: punishmentEmbeds,
                    noteEmbeds: noteEmbeds,
                    userId: interaction.user.id,
                    timeout: 1800000, // 30 minutes
                });

            } catch (err) {
                let errorMessage = '❌ **Failed to retrieve user information**\n\n';

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
                    console.error('[Find] Unexpected error:', err);
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
            console.error('[Find] Unhandled error:', unhandled);
        }
    },
};
