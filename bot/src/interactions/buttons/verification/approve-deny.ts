// bot/src/interactions/buttons/verification/approve-deny.ts
import {
    ButtonInteraction,
    MessageFlags,
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    ModalSubmitInteraction,
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
import { awardManualVerificationCredit } from '../../../lib/verification/manual-verification-credit.js';
import { withButtonLock, getVerificationLockKey } from '../../../lib/utilities/button-mutex.js';

import { z } from 'zod';
import { SnowflakeSchema } from '../../../lib/embeds/contract.js';

const ApproveButtonId = z.tuple([z.literal('verification'), z.literal('approve'), SnowflakeSchema]);
const ApproveModalId = z.tuple([
    z.literal('verification'), z.enum(['approve_confirm', 'approve_modal']),
    SnowflakeSchema, SnowflakeSchema, SnowflakeSchema,
]);

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
    const parsed = ApproveButtonId.safeParse(interaction.customId.split(':'));
    if (!parsed.success) {
        await interaction.reply({
            content: '❌ Invalid button data.',
            ephemeral: true,
        });
        return;
    }
    const userId = parsed.data[2];

    // CRITICAL: Wrap in mutex to prevent concurrent approval/denial
    const executed = await withButtonLock(interaction, getVerificationLockKey('review', userId), async () => {
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
            console.error('[VerificationApprove] Session not found', {
                userId,
                requestedBy: interaction.user.id,
                timestamp: new Date().toISOString(),
            });
            
            // Update the ticket message to show cancellation
            try {
                const ticketMessage = interaction.message;
                if (ticketMessage && ticketMessage.embeds.length > 0) {
                    const originalEmbed = EmbedBuilder.from(ticketMessage.embeds[0]);
                    
                    // Add cancellation message to description
                    const currentDescription = originalEmbed.data.description || '';
                    originalEmbed.setDescription(
                        currentDescription + '\n\n' +
                        '**Status:** ❌ Verification Canceled\n' +
                        'This verification session has been cancelled or expired.'
                    );
                    
                    await ticketMessage.edit({
                        embeds: [originalEmbed],
                        components: [], // Remove buttons
                    });
                }
            } catch (updateErr) {
                console.error('[VerificationApprove] Failed to update ticket message:', updateErr);
            }
            
            await interaction.reply({
                content: '❌ **Session Not Found**\n\n' +
                'Verification session not found. It may have been cancelled or expired.\n' +
                'The ticket has been updated.',
                ephemeral: true,
            });
            return;
        }
        
        console.log('[VerificationApprove] Session found', {
            userId,
            guildId: session.guild_id,
            status: session.status,
            expiresAt: session.expires_at,
            createdAt: session.created_at,
        });

        if (session.status !== 'pending_review') {
            await interaction.reply({
                content: '❌ **Invalid Status**\n\n' +
                `This verification request has already been ${session.status}.`,
                ephemeral: true,
            });
            return;
        }

        if (session.guild_id !== interaction.guild!.id || session.ticket_message_id !== interaction.message.id) {
            await interaction.reply({ content: 'This verification request is stale or belongs to another server.', flags: MessageFlags.Ephemeral });
            return;
        }

        // Get IGN from session (user provided it during ticket creation)
        const ign = session.rotmg_ign;

        if (!ign) {
            // Fallback to modal if IGN is missing (old tickets before this change)
            await showIgnInputModal(interaction, userId);
            return;
        }

        // Show confirmation modal with IGN pre-filled for verification
        const modal = new ModalBuilder()
            .setCustomId(`verification:approve_confirm:${userId}:${interaction.user.id}:${interaction.message.id}`)
            .setTitle('Confirm Verification Approval');

        const ignInput = new TextInputBuilder()
            .setCustomId('ign')
            .setLabel('IGN (verify this matches screenshot)')
            .setStyle(TextInputStyle.Short)
            .setValue(ign)
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
 * Fallback: Show IGN input modal for old tickets without IGN in session
 */
async function showIgnInputModal(interaction: ButtonInteraction, userId: string): Promise<void> {
    const modal = new ModalBuilder()
        .setCustomId(`verification:approve_modal:${userId}:${interaction.user.id}:${interaction.message.id}`)
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
}

/**
 * Handle modal submission for approval with IGN
 */
export async function handleVerificationApproveModal(interaction: ModalSubmitInteraction): Promise<void> {
    const parsed = ApproveModalId.safeParse(interaction.customId.split(':'));
    if (!parsed.success || parsed.data[3] !== interaction.user.id || parsed.data[4] !== interaction.message?.id) {
        await interaction.reply({ content: 'This approval form is invalid or belongs to another reviewer.', flags: MessageFlags.Ephemeral });
        return;
    }
    const userId = parsed.data[2];
    await withButtonLock(interaction, getVerificationLockKey('review', userId), async () => {
        await handleVerificationApproveModalInternal(interaction);
    }, { holdUntilSettled: true });
}

async function handleVerificationApproveModalInternal(interaction: ModalSubmitInteraction): Promise<void> {
    if (!interaction.inGuild() || !interaction.guild) {
        await interaction.reply({
            content: '❌ This modal can only be used in a server.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
        // Extract user ID from modal custom ID (supports both approve_confirm and approve_modal)
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
            console.error('[VerificationApproveModal] Session not found', {
                userId,
                requestedBy: interaction.user.id,
                timestamp: new Date().toISOString(),
            });
            
            // Try to find and update the ticket message to show cancellation
            try {
                const channel = interaction.channel;
                if (channel && channel.isTextBased()) {
                    // Search recent messages for the verification ticket
                    const messages = await channel.messages.fetch({ limit: 50 });
                    const ticketMessage = messages.find(msg => 
                        msg.embeds.length > 0 && 
                        msg.embeds[0].data.title === '🎫 Manual Verification Request' &&
                        msg.embeds[0].data.description?.includes(userId)
                    );
                    
                    if (ticketMessage && ticketMessage.embeds.length > 0) {
                        const originalEmbed = EmbedBuilder.from(ticketMessage.embeds[0]);
                        
                        // Add cancellation message to description
                        const currentDescription = originalEmbed.data.description || '';
                        originalEmbed.setDescription(
                            currentDescription + '\n\n' +
                            '**Status:** ❌ Verification Canceled\n' +
                            'This verification session has been cancelled or expired.'
                        );
                        
                        await ticketMessage.edit({
                            embeds: [originalEmbed],
                            components: [], // Remove buttons
                        });
                    }
                }
            } catch (updateErr) {
                console.error('[VerificationApproveModal] Failed to update ticket message:', updateErr);
            }
            
            await interaction.editReply(
                '❌ **Session Not Found**\n\n' +
                'Verification session not found. It may have already been processed or cancelled.'
            );
            return;
        }
        
        console.log('[VerificationDeny] Session found', {
            userId,
            guildId: session.guild_id,
            status: session.status,
            expiresAt: session.expires_at,
            createdAt: session.created_at,
        });

        if (session.status !== 'pending_review') {
            await interaction.editReply(
                '❌ **Invalid Status**\n\n' +
                `This verification request has already been ${session.status}.`
            );
            return;
        }

        const reviewer = await interaction.guild.members.fetch(interaction.user.id);
        if (!await hasInternalRole(reviewer, 'security') || session.guild_id !== interaction.guild.id
            || session.ticket_message_id !== interaction.message?.id) {
            await interaction.editReply('This verification request is stale or you are not authorized to review it.');
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

        // Check if verification failed completely
        if (!applyResult.success) {
            // Update session to show denial
            await updateSession(guildId, userId, {
                status: 'denied',
                reviewed_by_user_id: interaction.user.id,
                denial_reason: applyResult.errors.join('; '),
            });

            // Send error message to staff
            await interaction.editReply(
                `❌ **Verification Failed**\n\n` +
                `Could not verify <@${userId}> as **${ign}**.\n\n` +
                `**Errors:**\n${applyResult.errors.map(e => `• ${e}`).join('\n')}`
            );

            // Try to notify user (sanitize error messages to remove user details)
            try {
                const dmChannel = await userToVerify.createDM();
                
                // Sanitize errors for user DM
                const sanitizedErrors = applyResult.errors.map(error => {
                    // Remove user tags, IDs, and usernames from error messages for privacy
                    return error
                        .replace(/<@\d+>/g, 'another Discord account') // Remove mentions
                        .replace(/User ID: \d+/g, 'another Discord account') // Remove user IDs
                        .replace(/by [^\s]+#\d+ \(/g, 'by another Discord account (') // Remove user#discriminator
                        .replace(/by [^\s]+ \(/g, 'by another Discord account ('); // Remove username
                });
                
                const failureEmbed = new EmbedBuilder()
                    .setTitle('❌ Verification Failed')
                    .setDescription(
                        `**Server:** ${interaction.guild.name}\n\n` +
                        `Your verification could not be completed due to the following issues:\n\n` +
                        sanitizedErrors.map(e => `• ${e}`).join('\n') + '\n\n' +
                        'Please contact a staff member (Security+) for assistance.'
                    )
                    .setColor(0xFF0000)
                    .setTimestamp();

                await dmChannel.send({ embeds: [failureEmbed] });
            } catch (dmErr) {
                console.error('[VerificationApproveModal] Could not DM user about failure:', dmErr);
            }

            // Log failure
            await logVerificationEvent(
                interaction.guild,
                userId,
                `**❌ Manual verification failed** by <@${interaction.user.id}>\n` +
                `• IGN: \`${ign}\`\n` +
                `• Errors: ${applyResult.errors.join(', ')}`
            );

            return;
        }

        // Update session with IGN and approval
        const updatedSession = await updateSession(guildId, userId, {
            rotmg_ign: ign,
            status: 'verified',
            reviewed_by_user_id: interaction.user.id,
        });
        
        // If session was already gone, that's okay - verification already succeeded
        if (!updatedSession) {
            console.log(`[VerificationApproveModal] Session ${userId} was already cleaned up, but verification succeeded`);
        }

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
        try {
            const ticketMessage = interaction.message || (session.ticket_message_id
                ? await interaction.channel?.messages.fetch(session.ticket_message_id).catch(() => null)
                : null);

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
        } catch (ticketErr) {
            console.error('[VerificationApproveModal] Failed to update ticket message after approval:', ticketErr);
        }

        await interaction.editReply(
            `✅ **Verification Approved**\n\n` +
            `<@${userId}> has been verified as **${ign}**.\n` +
            `They have been notified via DM.`
        );

        // Award moderation points if configured
        try {
            const moderationPointsResult = await awardManualVerificationCredit(
                interaction.client,
                session,
                actorMember
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

const DenyButtonId = z.tuple([z.literal('verification'), z.literal('deny'), SnowflakeSchema]);
const DenyModalId = z.tuple([z.literal('verification'), z.literal('deny_modal'), SnowflakeSchema, SnowflakeSchema, SnowflakeSchema]);
const DenialReason = z.string().max(2000).transform(value => value.trim());

/** Retire only a missing/expired request's original UI; never touch a replacement request. */
async function retireStaleDenialMessage(interaction: ButtonInteraction | ModalSubmitInteraction): Promise<void> {
    try {
        const message = interaction.message;
        if (!message) return;
        const embed = message.embeds[0] ? EmbedBuilder.from(message.embeds[0]) : new EmbedBuilder();
        embed.setDescription('❌ Verification Canceled\nThis verification session has been cancelled or expired.');
        await message.edit({ embeds: [embed], components: [] });
    } catch {
        console.error('[VerificationDeny] Failed to retire stale request', { reviewerId: interaction.user.id });
    }
}

/** Open a reviewer-bound modal; no message content or pending collector state is needed. */
export async function handleVerificationDeny(interaction: ButtonInteraction): Promise<void> {
    try {
        const parsed = DenyButtonId.safeParse(interaction.customId.split(':'));
        if (!interaction.guild || !parsed.success) {
            await interaction.reply({ content: 'Invalid verification button or server.', flags: MessageFlags.Ephemeral });
            return;
        }
        const userId = parsed.data[2];
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (!await hasInternalRole(member, 'security')) {
            await interaction.reply({ content: 'You need the Security+ role to deny verification requests.', flags: MessageFlags.Ephemeral });
            return;
        }
        const session = await getSessionByUserId(userId);
        if (!session || session.guild_id !== interaction.guild.id || session.ticket_message_id !== interaction.message.id
            || session.status !== 'pending_review') {
            if (!session) {
                await retireStaleDenialMessage(interaction);
            }
            await interaction.reply({ content: 'This verification request has expired or already been processed.', flags: MessageFlags.Ephemeral });
            return;
        }
        const modal = new ModalBuilder()
            .setCustomId(`verification:deny_modal:${userId}:${interaction.user.id}:${interaction.message.id}`)
            .setTitle('Deny Verification')
            .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder()
                .setCustomId('reason').setLabel('Denial reason (sent to the user)')
                .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(2000)));
        await interaction.showModal(modal);
    } catch {
        console.error('[VerificationDeny] Could not open modal', { reviewerId: interaction.user.id });
        if (!interaction.replied && !interaction.deferred) await interaction.reply({
            content: 'An error occurred while opening the denial form. Please try again.', flags: MessageFlags.Ephemeral,
        });
    }
}

export async function handleVerificationDenyModal(interaction: ModalSubmitInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
        const parsed = DenyModalId.safeParse(interaction.customId.split(':'));
        if (!interaction.guild || !parsed.success || parsed.data[3] !== interaction.user.id
            || !interaction.message || parsed.data[4] !== interaction.message.id) {
            await interaction.editReply('This denial form is invalid or belongs to another reviewer.');
            return;
        }
        const [, , userId, , ticketId] = parsed.data;
        await withButtonLock(interaction, getVerificationLockKey('review', userId), async () => {
            const member = await interaction.guild!.members.fetch(interaction.user.id);
            if (!await hasInternalRole(member, 'security')) {
                await interaction.editReply('You need the Security+ role to deny verification requests.');
                return;
            }
            const session = await getSessionByUserId(userId);
            if (!session || session.guild_id !== interaction.guild!.id || session.ticket_message_id !== ticketId
                || session.status !== 'pending_review') {
                if (!session) {
                    await retireStaleDenialMessage(interaction);
                }
                await interaction.editReply('This verification request has expired or already been processed.');
                return;
            }
            const reason = DenialReason.parse(interaction.fields.getTextInputValue('reason'));
            const guildId = session.guild_id;
            // Update session with denial
            const deniedSession = await updateSession(guildId, userId, {
                status: 'denied',
                reviewed_by_user_id: interaction.user.id,
                denial_reason: reason || 'No reason provided',
            });

            if (!deniedSession) {
                await interaction.editReply('This verification session has expired or already been processed.');
                return;
            }
            console.log('[VerificationDeny] Manual verification denied', { userId, reviewerId: interaction.user.id, ticketId });
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
                console.error('[VerificationDeny] Could not DM user:', { userId, reviewerId: interaction.user.id });
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

            await interaction.message!.edit({
                embeds: [ticketEmbed],
                components: [], // Remove buttons
            });

            await interaction.editReply({
                content: `✅ **Verification Denied**\n\n<@${userId}> has been notified.`,
            });

            // Handling a manual verification earns the same configured credit for either decision.
            try {
                const moderationPointsResult = await awardManualVerificationCredit(
                    interaction.client,
                    session,
                    member
                );

                if (moderationPointsResult.points_awarded > 0) {
                    console.log(`[VerificationDeny] Awarded ${moderationPointsResult.points_awarded} moderation points to ${interaction.user.id}`);
                }
            } catch (modPointsErr) {
                // Non-critical error - log but don't fail the denial
                console.error('[VerificationDeny] Failed to award moderation points:', { userId, reviewerId: interaction.user.id });
            }

            // Log denial
            await logVerificationEvent(
                interaction.guild!,
                userId,
                `**❌ Manual verification denied** by <@${interaction.user.id}>\n` +
                `**Reason:** ${reason || 'No reason provided'}`,
                { error: true, redactErrorDetails: true }
            );

            // Clean up session immediately after denial
            try {
                await deleteSession(guildId, userId);
            } catch (err) {
                console.error('[VerificationDeny] Failed to delete session:', { userId, reviewerId: interaction.user.id });
            }
        }, { holdUntilSettled: true });
    } catch {
        // Discord REST errors can contain request bodies (including the reason).
        console.error('[VerificationDeny] Denial failed', { reviewerId: interaction.user.id });
        await interaction.editReply('An error occurred while denying verification. Please try again.');
    }
}
