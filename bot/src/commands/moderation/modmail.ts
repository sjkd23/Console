// bot/src/commands/moderation/modmail.ts
import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    ComponentType,
    Guild,
} from 'discord.js';
import type { SlashCommand } from '../_types.js';
import {
    generateModmailTicketId,
    createModmailMessageEmbed,
    createModmailTicketEmbed,
    extractAttachments,
    validateModmailContent,
} from '../../lib/modmail/modmail.js';
import {
    createModmailTicket,
    getGuildChannels,
    checkModmailBlacklist,
    getGuildModmailTickets,
    BackendError,
} from '../../lib/utilities/http.js';

interface ModmailState {
    guilds: Guild[];
    selectedGuildId?: string;
    message?: string;
    attachments?: string[];
}

const MODMAIL_STATE = new Map<string, ModmailState>();

export const modmail: SlashCommand = {
    data: new SlashCommandBuilder()
        .setName('modmail')
        .setDescription('Send a modmail message to server staff')
        .setDMPermission(true), // Allow in DMs

    async run(interaction: ChatInputCommandInteraction): Promise<void> {
        // Acknowledge the command immediately
        await interaction.reply({
            content: '📬 **Modmail System**\n\nCheck your DMs to continue submitting your modmail!',
            ephemeral: true,
        });

        try {
            // Get all guilds the bot is in that the user is also in
            const mutualGuilds = interaction.client.guilds.cache.filter(guild => 
                guild.members.cache.has(interaction.user.id)
            );

            if (mutualGuilds.size === 0) {
                try {
                    const dmChannel = await interaction.user.createDM();
                    await dmChannel.send('❌ You are not a member of any servers where this bot is present.');
                } catch {
                    await interaction.followUp({
                        content: '❌ You are not a member of any servers where this bot is present.',
                        ephemeral: true,
                    });
                }
                return;
            }

            // Try to open DM with user
            let dmChannel;
            try {
                dmChannel = await interaction.user.createDM();
            } catch (error) {
                await interaction.followUp({
                    content: '❌ I couldn\'t send you a DM! Please enable DMs from server members and try again.',
                    ephemeral: true,
                });
                return;
            }

            // Store state for this user
            const state: ModmailState = {
                guilds: Array.from(mutualGuilds.values()),
            };
            MODMAIL_STATE.set(interaction.user.id, state);

            // Create guild selection dropdown
            const guildOptions = state.guilds.slice(0, 25).map(guild => ({
                label: guild.name.length > 100 ? guild.name.substring(0, 97) + '...' : guild.name,
                value: guild.id,
                description: `Server ID: ${guild.id}`,
            }));

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId(`modmail:select_guild:${interaction.user.id}`)
                .setPlaceholder('Select a server...')
                .addOptions(guildOptions);

            const row = new ActionRowBuilder<StringSelectMenuBuilder>()
                .addComponents(selectMenu);

            // Send to DM
            await dmChannel.send({
                content: '📬 **Submit Modmail**\n\nPlease select which server you want to send this modmail to:',
                components: [row],
            });

            // Wait for guild selection in DM
            const collector = dmChannel.createMessageComponentCollector({
                filter: i => i.user.id === interaction.user.id && i.customId.startsWith('modmail:select_guild:'),
                time: 5 * 60 * 1000, // 5 minutes
                componentType: ComponentType.StringSelect,
            });

            collector.on('collect', async selectInteraction => {
                if (!selectInteraction.isStringSelectMenu()) return;

                await selectInteraction.deferUpdate();
                
                const selectedGuildId = selectInteraction.values[0];
                const selectedGuild = state.guilds.find(g => g.id === selectedGuildId);

                if (!selectedGuild) {
                    await selectInteraction.editReply({
                        content: '❌ Selected server not found.',
                        components: [],
                    });
                    collector.stop();
                    return;
                }

                // Check if user is blacklisted from modmail in this guild
                try {
                    const blacklistStatus = await checkModmailBlacklist(selectedGuildId, interaction.user.id);
                    
                    if (blacklistStatus.blacklisted) {
                        await selectInteraction.editReply({
                            content: 
                                `❌ **Modmail Blacklisted**\n\n` +
                                `You're blacklisted from modmail in **${selectedGuild.name}**.\n\n` +
                                `**Reason:** ${blacklistStatus.reason || 'No reason provided'}\n\n` +
                                `Contact a server admin directly if you believe this is wrong.`,
                            components: [],
                        });
                        collector.stop();
                        MODMAIL_STATE.delete(interaction.user.id);
                        return;
                    }
                } catch (error) {
                    console.error('[Modmail] Error checking blacklist:', error);
                    // Continue anyway if blacklist check fails (don't block legitimate users)
                }

                // Check if user already has an open ticket in this guild
                try {
                    const existingTickets = await getGuildModmailTickets(selectedGuildId, 'open');
                    const userHasOpenTicket = existingTickets.tickets.some(t => t.user_id === interaction.user.id);
                    
                    if (userHasOpenTicket) {
                        await selectInteraction.editReply({
                            content: 
                                `⚠️ **Existing Ticket**\n\n` +
                                `You already have an open modmail ticket in **${selectedGuild.name}**.\n\n` +
                                `Wait for staff to respond before creating a new ticket.`,
                            components: [],
                        });
                        collector.stop();
                        MODMAIL_STATE.delete(interaction.user.id);
                        return;
                    }
                } catch (error) {
                    console.error('[Modmail] Error checking existing tickets:', error);
                    // Continue anyway - backend will catch this if needed
                }

                state.selectedGuildId = selectedGuildId;

                // Ask user to send their message
                await selectInteraction.editReply({
                    content: 
                        `📝 **Selected Server:** ${selectedGuild.name}\n\n` +
                        'Send your message here with text and/or attachments.\n\n' +
                        '**Type your message below** (5 minutes):',
                    components: [],
                });

                // Wait for message in DM
                const messageCollector = dmChannel.createMessageCollector({
                    filter: (m: any) => m.author.id === interaction.user.id,
                    time: 5 * 60 * 1000,
                    max: 1,
                });

                messageCollector.on('collect', async (message: any) => {
                    const content = message.content;
                    const attachments = extractAttachments(message);

                    // Validate content
                    const validationError = validateModmailContent(content, attachments);
                    if (validationError) {
                        await dmChannel.send(`❌ ${validationError}`);
                        return;
                    }

                    state.message = content;
                    state.attachments = attachments;

                    // Show confirmation
                    const previewEmbed = createModmailMessageEmbed(
                        interaction.user,
                        content,
                        attachments,
                        'Preview'
                    );

                    const confirmRow = new ActionRowBuilder<ButtonBuilder>()
                        .addComponents(
                            new ButtonBuilder()
                                .setCustomId(`modmail:confirm:${interaction.user.id}`)
                                .setLabel('Send')
                                .setStyle(ButtonStyle.Success)
                                .setEmoji('📤'),
                            new ButtonBuilder()
                                .setCustomId(`modmail:cancel:${interaction.user.id}`)
                                .setLabel('Cancel')
                                .setStyle(ButtonStyle.Secondary)
                                .setEmoji('❌')
                        );

                    await dmChannel.send({
                        content: `📤 **Confirm Modmail**\n\nSending to **${selectedGuild.name}**:`,
                        embeds: [previewEmbed],
                        components: [confirmRow],
                    });
                });

                messageCollector.on('end', (collected: any, reason: string) => {
                    if (reason === 'time' && collected.size === 0) {
                        dmChannel.send('⏱️ Modmail submission timed out. Please run `/modmail` again to start over.');
                        MODMAIL_STATE.delete(interaction.user.id);
                    }
                });

                collector.stop();
            });

            collector.on('end', (collected, reason) => {
                if (reason === 'time' && collected.size === 0) {
                    dmChannel.send('⏱️ Modmail submission timed out. Please run `/modmail` again to start over.');
                    MODMAIL_STATE.delete(interaction.user.id);
                }
            });

        } catch (error) {
            console.error('[Modmail] Error in modmail command:', error);
            try {
                await interaction.followUp({
                    content: '❌ An error occurred while processing your modmail request. Please try again later.',
                    ephemeral: true,
                });
            } catch {
                // Interaction might have expired
            }
        }
    },
};

/**
 * Export handlers for button interactions
 */
export async function handleModmailConfirm(interaction: any): Promise<void> {
    const userId = interaction.customId.split(':')[2];
    
    if (userId !== interaction.user.id) {
        await interaction.reply({
            content: '❌ This button is not for you.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await interaction.deferUpdate();

    // Remove buttons from the confirmation message
    try {
        await interaction.message.edit({
            components: [],
        });
    } catch (error) {
        console.error('[Modmail] Failed to remove buttons:', error);
    }

    const state = MODMAIL_STATE.get(userId);
    if (!state || !state.selectedGuildId || !state.message) {
        await interaction.followUp({
            content: '❌ Modmail session expired. Please run `/modmail` again.',
        });
        return;
    }

    try {
        const guild = interaction.client.guilds.cache.get(state.selectedGuildId);
        if (!guild) {
            await interaction.followUp({
                content: '❌ Could not find the selected server.',
            });
            MODMAIL_STATE.delete(userId);
            return;
        }

        // Get modmail channel
        const channelsData = await getGuildChannels(state.selectedGuildId);
        const modmailChannelId = channelsData.channels.modmail;

        if (!modmailChannelId) {
            await interaction.followUp({
                content: `❌ **Modmail Not Configured**\n\n${guild.name} has not set up a modmail channel yet. Please contact a server administrator.`,
            });
            MODMAIL_STATE.delete(userId);
            return;
        }

        const modmailChannel = await guild.channels.fetch(modmailChannelId);
        if (!modmailChannel || !modmailChannel.isTextBased()) {
            await interaction.followUp({
                content: '❌ Modmail channel not found or is not a text channel.',
            });
            MODMAIL_STATE.delete(userId);
            return;
        }

        // Generate ticket ID
        const ticketId = generateModmailTicketId();

        // Create embed for modmail channel
        const ticketEmbed = createModmailTicketEmbed(
            interaction.user,
            guild,
            state.message,
            state.attachments || [],
            ticketId
        );

        // Create close button
        const closeButton = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`modmail:close:${ticketId}`)
                    .setLabel('Close Ticket')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('🔒')
            );

        // Send to modmail channel
        const modmailMessage = await (modmailChannel as any).send({
            embeds: [ticketEmbed],
            components: [closeButton],
        });

        // Create thread
        const thread = await modmailMessage.startThread({
            name: `${ticketId} - ${interaction.user.tag}`,
            autoArchiveDuration: 1440, // 24 hours
        });

        // Save to database
        try {
            await createModmailTicket({
                ticket_id: ticketId,
                guild_id: state.selectedGuildId,
                user_id: userId,
                content: state.message,
                attachments: state.attachments || [],
                thread_id: thread.id,
                message_id: modmailMessage.id,
            });
        } catch (err) {
            // Handle existing ticket error
            if (err instanceof BackendError && err.code === 'EXISTING_TICKET') {
                await interaction.followUp({
                    content: 
                        `⚠️ **Existing Ticket**\n\n` +
                        `You already have an open modmail ticket in **${guild.name}**.\n\n` +
                        `Please wait for staff to respond to your existing ticket before creating a new one.`,
                });
                // Clean up the message and thread we created
                try {
                    await thread.delete();
                    await modmailMessage.delete();
                } catch (cleanupErr) {
                    console.error('[Modmail] Failed to clean up after existing ticket error:', cleanupErr);
                }
                MODMAIL_STATE.delete(userId);
                return;
            }
            // Re-throw other errors
            throw err;
        }

        // Send confirmation to user (in DM)
        await interaction.followUp({
            content: 
                `✅ **Modmail Sent!**\n\n` +
                `Your message has been sent to **${guild.name}** staff.\n` +
                `**Ticket ID:** ${ticketId}\n\n` +
                `You'll get a DM if they reply.`,
        });

        // Send initial message in thread
        await thread.send({
            content: 
                `📬 **New Modmail**\n\n` +
                `**From:** ${interaction.user.tag} (${interaction.user.id})\n` +
                `**Ticket ID:** ${ticketId}\n\n` +
                `Use \`/modmailreply\` to respond.`,
        });

        MODMAIL_STATE.delete(userId);

    } catch (error) {
        console.error('[Modmail] Error submitting modmail:', error);
        await interaction.followUp({
            content: '❌ Failed to submit modmail. Please try again later.',
        });
        MODMAIL_STATE.delete(userId);
    }
}

export async function handleModmailCancel(interaction: any): Promise<void> {
    const userId = interaction.customId.split(':')[2];
    
    if (userId !== interaction.user.id) {
        await interaction.reply({
            content: '❌ This button is not for you.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await interaction.deferUpdate();

    // Remove buttons from the confirmation message
    try {
        await interaction.message.edit({
            components: [],
        });
    } catch (error) {
        console.error('[Modmail] Failed to remove buttons:', error);
    }

    MODMAIL_STATE.delete(userId);

    await interaction.followUp({
        content: '❌ Modmail submission cancelled.',
    });
}
