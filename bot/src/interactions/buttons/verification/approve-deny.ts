// bot/src/interactions/buttons/verification/approve-deny.ts
import {
    ButtonInteraction,
    MessageFlags,
    EmbedBuilder,
    GuildMember,
    Message,
    ComponentType,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    ModalSubmitInteraction,
    Collection,
    TextBasedChannel,
    ReadonlyCollection,
} from 'discord.js';
import {
    getSessionByUserId,
    updateSession,
    applyVerification,
    createSuccessEmbed,
    deleteSession,
    validateIGN,
    logVerificationEvent,
} from '../../../lib/verification/verification.js';
import { hasInternalRole } from '../../../lib/permissions/permissions.js';
import { awardModerationPointsWithUpdate } from '../../../lib/utilities/http.js';
import { getMemberRoleIds } from '../../../lib/permissions/permissions.js';
import { withButtonLock, getVerificationLockKey } from '../../../lib/utilities/button-mutex.js';

const DENIAL_REASON_TIMEOUT = 5 * 60 * 1000; // 5 minutes

/**
 * Handle "Approve" button on manual verification ticket
 * Security+ only
 */
export async function handleVerificationApprove(interaction: ButtonInteraction): Promise<void> {
    if (!interaction.inGuild() || !interaction.guild) {
        await interaction.reply({
            content: '❌ This button can only be used in a server.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    // Extract user ID from button custom ID (need it for lock key)
    const userId = interaction.customId.split(':')[2];
    if (!userId) {
        await interaction.reply({
            content: '❌ Invalid button data.',
            ephemeral: true,
        });
        return;
    }

    // CRITICAL: Wrap in mutex to prevent concurrent approval/denial
    const executed = await withButtonLock(interaction, getVerificationLockKey('approve', userId), async () => {
        await handleVerificationApproveInternal(interaction, userId);
    });

    if (!executed) {
        // Lock was not acquired, user was already notified
        return;
    }
}

/**
 * Internal handler for verification approval (protected by mutex).
 */
async function handleVerificationApproveInternal(interaction: ButtonInteraction, userId: string): Promise<void> {
    try {
        // Check if user has security+ role
        const member = await interaction.guild!.members.fetch(interaction.user.id);
        const hasPermission = await hasInternalRole(member, 'security');

        if (!hasPermission) {
            await interaction.reply({
                content: '❌ **Access Denied**\n\n' +
                'You need the Security+ role to approve verification requests.',
                ephemeral: true,
            });
            return;
        }

        // Get session
        const session = await getSessionByUserId(userId);

        if (!session) {
            await interaction.reply({
                content: '❌ **Session Not Found**\n\n' +
                'Verification session not found. It may have been cancelled or expired.',
                ephemeral: true,
            });
            return;
        }

        if (session.status !== 'pending_review') {
            await interaction.reply({
                content: '❌ **Invalid Status**\n\n' +
                `This verification request has already been ${session.status}.`,
                ephemeral: true,
            });
            return;
        }

        // Show modal to collect IGN
        const modal = new ModalBuilder()
            .setCustomId(`verification:approve_modal:${userId}`)
            .setTitle('Approve Verification');

        const ignInput = new TextInputBuilder()
            .setCustomId('ign')
            .setLabel('IGN (from screenshot)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Enter the user\'s ROTMG IGN')
            .setRequired(true)
            .setMaxLength(16);

        const actionRow = new ActionRowBuilder<TextInputBuilder>().addComponents(ignInput);
        modal.addComponents(actionRow);

        await interaction.showModal(modal);
    } catch (err) {
        console.error('[VerificationApprove] Error:', err);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: '❌ An error occurred while processing the approval.',
                ephemeral: true,
            });
        }
    }
}

/**
 * Handle modal submission for approval with IGN
 */
export async function handleVerificationApproveModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (!interaction.inGuild() || !interaction.guild) {
        await interaction.reply({
            content: '❌ This modal can only be used in a server.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
        // Extract user ID from modal custom ID
        const userId = interaction.customId.split(':')[2];
        const ign = interaction.fields.getTextInputValue('ign').trim();

        // Validate IGN
        const validation = validateIGN(ign);
        if (!validation.valid) {
            await interaction.editReply(
                `❌ **Invalid IGN**: ${validation.error}\n\n` +
                'Please click the Approve button again and enter a valid IGN.'
            );
            return;
        }

        // Get session
        const session = await getSessionByUserId(userId);

        if (!session) {
            await interaction.editReply(
                '❌ **Session Not Found**\n\n' +
                'Verification session not found. It may have been cancelled or expired.'
            );
            return;
        }

        if (session.status !== 'pending_review') {
            await interaction.editReply(
                '❌ **Invalid Status**\n\n' +
                `This verification request has already been ${session.status}.`
            );
            return;
        }

        const guildId = session.guild_id;

        // Get the user and apply verification
        const userToVerify = await interaction.guild.members.fetch(userId);
        const actorMember = await interaction.guild.members.fetch(interaction.user.id);
        
        const applyResult = await applyVerification(
            interaction.guild,
            userToVerify,
            ign,
            interaction.user.id,
            actorMember
        );

        // Update session with IGN and approval
        await updateSession(guildId, userId, {
            rotmg_ign: ign,
            status: 'verified',
            reviewed_by_user_id: interaction.user.id,
        });

        // Send DM to user
        try {
            const dmChannel = await userToVerify.createDM();
            const successEmbed = createSuccessEmbed(
                interaction.guild.name,
                ign,
                applyResult.roleApplied,
                applyResult.nicknameSet,
                applyResult.errors
            );

            await dmChannel.send({
                embeds: [successEmbed],
            });
        } catch (dmErr) {
            console.error('[VerificationApproveModal] Could not DM user:', dmErr);
        }

        // Update ticket message
        const ticketMessage = interaction.message || await interaction.channel?.messages.fetch(session.ticket_message_id!);
        
        if (ticketMessage) {
            const ticketEmbed = new EmbedBuilder()
                .setTitle('✅ Verification Approved')
                .setDescription(
                    `**User:** <@${userId}>\n` +
                    `**IGN:** ${ign}\n` +
                    `**Approved by:** <@${interaction.user.id}>\n\n` +
                    `**Result:**\n` +
                    `${applyResult.roleApplied ? '✅' : '❌'} Role applied\n` +
                    `${applyResult.nicknameSet ? '✅' : '❌'} Nickname set\n\n` +
                    (applyResult.errors.length > 0
                        ? `**Issues:**\n${applyResult.errors.map(e => `• ${e}`).join('\n')}`
                        : '')
                )
                .setColor(0x00FF00)
                .setTimestamp();

            await ticketMessage.edit({
                embeds: [ticketEmbed],
                components: [], // Remove buttons
            });
        }

        await interaction.editReply(
            `✅ **Verification Approved**\n\n` +
            `<@${userId}> has been verified as **${ign}**.\n` +
            `They have been notified via DM.`
        );

        // Award moderation points if configured
        try {
            const actorRoles = getMemberRoleIds(actorMember);
            const moderationPointsResult = await awardModerationPointsWithUpdate(
                interaction.client,
                guildId,
                interaction.user.id,
                {
                    actor_user_id: interaction.user.id,
                    actor_roles: actorRoles,
                    command_type: 'verify',
                }
            );
            
            if (moderationPointsResult.points_awarded > 0) {
                console.log(`[VerificationApproveModal] Awarded ${moderationPointsResult.points_awarded} moderation points to ${interaction.user.id}`);
            }
        } catch (modPointsErr) {
            // Non-critical error - log but don't fail the verification
            console.error('[VerificationApproveModal] Failed to award moderation points:', modPointsErr);
        }

        // Log approval
        await logVerificationEvent(
            interaction.guild,
            userId,
            `**✅ Manual verification approved** by <@${interaction.user.id}>\n` +
            `• IGN: \`${ign}\`\n` +
            `• Role Applied: ${applyResult.roleApplied ? '✅' : '❌'}\n` +
            `• Nickname Set: ${applyResult.nicknameSet ? '✅' : '❌'}` +
            (applyResult.errors.length > 0 ? `\n• Errors: ${applyResult.errors.join(', ')}` : '')
        );

        // Clean up session after delay
        setTimeout(() => {
            deleteSession(guildId, userId).catch(console.error);
        }, 60000);
    } catch (err) {
        console.error('[VerificationApproveModal] Error:', err);
        await interaction.editReply(
            '❌ An error occurred while approving verification. Please try again.'
        );
    }
}

/**
 * Handle "Deny" button on manual verification ticket
 * Security+ only
 */
export async function handleVerificationDeny(interaction: ButtonInteraction): Promise<void> {
    if (!interaction.inGuild() || !interaction.guild) {
        await interaction.reply({
            content: '❌ This button can only be used in a server.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    // Extract user ID from button custom ID (need it for lock key)
    const userId = interaction.customId.split(':')[2];
    if (!userId) {
        await interaction.reply({
            content: '❌ Invalid button data.',
            ephemeral: true,
        });
        return;
    }

    // Defer first since we need to do permission check
    await interaction.deferReply({ ephemeral: true });

    // CRITICAL: Wrap in mutex to prevent concurrent approval/denial
    const executed = await withButtonLock(interaction, getVerificationLockKey('deny', userId), async () => {
        await handleVerificationDenyInternal(interaction, userId);
    });

    if (!executed) {
        // Lock was not acquired, user was already notified
        return;
    }
}

/**
 * Internal handler for verification denial (protected by mutex).
 */
async function handleVerificationDenyInternal(interaction: ButtonInteraction, userId: string): Promise<void> {

    try {
        // Check if user has security+ role
        if (!interaction.guild) {
            await interaction.editReply('❌ This command can only be used in a server.');
            return;
        }

        const member = await interaction.guild.members.fetch(interaction.user.id);
        const hasPermission = await hasInternalRole(member, 'security');

        if (!hasPermission) {
            await interaction.editReply(
                '❌ **Access Denied**\n\n' +
                'You need the Security+ role to deny verification requests.'
            );
            return;
        }

        // Extract user ID from button custom ID
        const userId = interaction.customId.split(':')[2];

        if (!userId) {
            await interaction.editReply('❌ Invalid button data.');
            return;
        }

        // Get session
        const session = await getSessionByUserId(userId);

        if (!session) {
            await interaction.editReply(
                '❌ **Session Not Found**\n\n' +
                'Verification session not found. It may have been cancelled or expired.'
            );
            return;
        }

        if (session.status !== 'pending_review') {
            await interaction.editReply(
                '❌ **Invalid Status**\n\n' +
                `This verification request has already been ${session.status}.`
            );
            return;
        }

        const guildId = session.guild_id;

        // Ask for denial reason
        await interaction.editReply(
            '📝 **Provide Denial Reason**\n\n' +
            'Please type a message in **this channel** explaining why this verification was denied.\n' +
            'The user will receive this message.\n\n' +
            '⏱️ You have 5 minutes to respond.'
        );

        // Collect reason from staff member
        const channel = interaction.channel;
        if (!channel || !channel.isTextBased()) {
            console.error('[VerificationDeny] Channel is not text-based or null');
            await interaction.followUp({
                content: '❌ Could not set up message collector - invalid channel type.',
                ephemeral: true,
            });
            return;
        }

        // Type guard: ensure channel supports message collection
        if (!('createMessageCollector' in channel)) {
            console.error('[VerificationDeny] Channel does not support createMessageCollector');
            await interaction.followUp({
                content: '❌ This channel type does not support message collection.',
                ephemeral: true,
            });
            return;
        }

        console.log(`[VerificationDeny] Creating message collector for user ${interaction.user.id} in channel ${channel.id}`);

        const collector = channel.createMessageCollector({
            filter: (m: Message) => {
                console.log(`[VerificationDeny] Message received from ${m.author.id}, expecting ${interaction.user.id}, match: ${m.author.id === interaction.user.id}`);
                return m.author.id === interaction.user.id && !m.author.bot;
            },
            time: DENIAL_REASON_TIMEOUT,
            max: 1,
        });

        console.log('[VerificationDeny] Message collector created successfully');

        collector.on('collect', async (message: Message) => {
            console.log(`[VerificationDeny] Collected message from ${message.author.tag}: "${message.content}"`);
            const reason = message.content.trim();

            // Update session with denial
            await updateSession(guildId, userId, {
                status: 'denied',
                reviewed_by_user_id: interaction.user.id,
                denial_reason: reason || 'No reason provided',
            });

            // Send DM to user
            try {
                const userToNotify = await interaction.client.users.fetch(userId);
                const dmChannel = await userToNotify.createDM();

                const denialEmbed = new EmbedBuilder()
                    .setTitle('❌ Verification Denied')
                    .setDescription(
                        `**Server:** ${interaction.guild!.name}\n\n` +
                        `Your manual verification request has been denied.\n\n` +
                        `**Reason:**\n${reason || 'No reason provided'}\n\n` +
                        'If you believe this is a mistake, please contact a staff member.\n' +
                        'You can submit a new verification request by clicking the "Get Verified" button again.'
                    )
                    .setColor(0xFF0000)
                    .setTimestamp();

                await dmChannel.send({ embeds: [denialEmbed] });
            } catch (dmErr) {
                console.error('[VerificationDeny] Could not DM user:', dmErr);
            }

            // Update ticket message
            const ticketEmbed = new EmbedBuilder()
                .setTitle('❌ Verification Denied')
                .setDescription(
                    `**User:** <@${userId}>\n` +
                    `**IGN:** ${session.rotmg_ign}\n` +
                    `**Denied by:** <@${interaction.user.id}>\n\n` +
                    `**Reason:**\n${reason || 'No reason provided'}`
                )
                .setColor(0xFF0000)
                .setTimestamp();

            await interaction.message.edit({
                embeds: [ticketEmbed],
                components: [], // Remove buttons
            });

            await interaction.followUp({
                content: `✅ **Verification Denied**\n\n<@${userId}> has been notified.`,
                ephemeral: true,
            });

            // Log denial
            await logVerificationEvent(
                interaction.guild!,
                userId,
                `**❌ Manual verification denied** by <@${interaction.user.id}>\n` +
                `**Reason:** ${reason || 'No reason provided'}`,
                { error: true }
            );

            // Delete the reason message
            try {
                await message.delete();
            } catch {}

            // Clean up session after delay
            setTimeout(() => {
                deleteSession(guildId, userId).catch(console.error);
            }, 60000);
        });

        collector.on('end', async (collected: ReadonlyCollection<string, Message>, reason: string) => {
            console.log(`[VerificationDeny] Collector ended. Reason: ${reason}, Collected: ${collected.size}`);
            if (reason === 'time' && collected.size === 0) {
                // No reason provided within timeout
                await updateSession(guildId, userId, {
                    status: 'denied',
                    reviewed_by_user_id: interaction.user.id,
                });

                // Send DM to user without reason
                try {
                    const userToNotify = await interaction.client.users.fetch(userId);
                    const dmChannel = await userToNotify.createDM();

                    const denialEmbed = new EmbedBuilder()
                        .setTitle('❌ Verification Denied')
                        .setDescription(
                            `**Server:** ${interaction.guild!.name}\n\n` +
                            `Your manual verification request has been denied.\n\n` +
                            'If you have questions, please contact a staff member.\n' +
                            'You can submit a new verification request by clicking the "Get Verified" button again.'
                        )
                        .setColor(0xFF0000)
                        .setTimestamp();

                    await dmChannel.send({ embeds: [denialEmbed] });
                } catch (dmErr) {
                    console.error('[VerificationDeny] Could not DM user:', dmErr);
                }

                // Update ticket message
                const ticketEmbed = new EmbedBuilder()
                    .setTitle('❌ Verification Denied')
                    .setDescription(
                        `**User:** <@${userId}>\n` +
                        `**IGN:** ${session.rotmg_ign}\n` +
                        `**Denied by:** <@${interaction.user.id}>\n\n` +
                        `**Reason:** No reason provided (timeout)`
                    )
                    .setColor(0xFF0000)
                    .setTimestamp();

                await interaction.message.edit({
                    embeds: [ticketEmbed],
                    components: [], // Remove buttons
                });

                await interaction.followUp({
                    content: `⏱️ **Timeout**\n\nNo reason provided. <@${userId}> has been notified of denial.`,
                    ephemeral: true,
                });

                // Clean up session
                setTimeout(() => {
                    deleteSession(guildId, userId).catch(console.error);
                }, 60000);
            }
        });
    } catch (err) {
        console.error('[VerificationDeny] Error:', err);
        await interaction.editReply(
            '❌ An error occurred while denying verification. Please try again.'
        );
    }
}
