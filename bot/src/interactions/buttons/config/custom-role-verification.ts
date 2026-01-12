// bot/src/interactions/buttons/config/custom-role-verification.ts
import {
    ButtonInteraction,
    MessageFlags,
    DMChannel,
    Message,
    ComponentType,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ModalSubmitInteraction,
    GuildMember,
    TextChannel,
} from 'discord.js';
import {
    getCustomRoleVerificationConfig,
    createCustomRoleVerificationSession,
    getCustomRoleVerificationSessionByUser,
    updateCustomRoleVerificationSession,
    getCustomRoleVerificationSession,
    BackendError,
    type CustomRoleVerificationSession,
} from '../../../lib/utilities/http.js';
import { hasInternalRole, getMemberRoleIds } from '../../../lib/permissions/permissions.js';
import { logVerificationEvent } from '../../../lib/verification/verification.js';
import { withButtonLock } from '../../../lib/utilities/button-mutex.js';

const MESSAGE_COLLECT_TIMEOUT = 5 * 60 * 1000; // 5 minutes

/**
 * Handle "Get Verified" button for custom role verification
 * customrole:get_verified:CONFIG_ID
 */
export async function handleCustomRoleGetVerified(interaction: ButtonInteraction): Promise<void> {
    if (!interaction.inGuild() || !interaction.guild) {
        await interaction.reply({
            content: '❌ This button can only be used in a server.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
        // Extract config ID from custom ID
        const configId = parseInt(interaction.customId.split(':')[2]);

        // Get config by doing a manual fetch since we only have the ID
        // We'll get the full config data when we create the session
        const member = await interaction.guild.members.fetch(interaction.user.id);

        // Create session first to get the config data joined
        const session = await createCustomRoleVerificationSession({
            guild_id: interaction.guildId!,
            user_id: interaction.user.id,
            role_verification_id: configId,
        });

        // Get the full session with config data
        const fullSession = await getCustomRoleVerificationSession(session.id);

        // Check if user already has the role
        if (member.roles.cache.has(fullSession.role_id!)) {
            await interaction.editReply(
                '✅ You already have this role! Contact staff if you need assistance.'
            );
            return;
        }

        // Check for existing active session (don't count this new one)
        try {
            const existingSession = await getCustomRoleVerificationSessionByUser(interaction.user.id);
            if (existingSession &&
                existingSession.id !== session.id &&
                existingSession.status !== 'expired' &&
                existingSession.status !== 'approved' &&
                existingSession.status !== 'denied' &&
                existingSession.status !== 'cancelled') {
                // Delete the session we just created
                await updateCustomRoleVerificationSession(session.id, { status: 'cancelled' });
                await interaction.editReply(
                    `⚠️ You already have an active role verification (status: ${existingSession.status}). ` +
                    'Complete or wait for that to finish before starting a new one.'
                );
                return;
            }
        } catch (err) {
            // Session not found is OK
        }

        // Try to open DM
        let dmChannel: DMChannel;
        try {
            dmChannel = await interaction.user.createDM();
        } catch (err) {
            await logVerificationEvent(
                interaction.guild,
                interaction.user.id,
                `**[Custom Role] Failed to send DM** - User has DMs disabled.`,
                { error: true }
            );
            await interaction.editReply(
                '❌ **DMs are disabled**\n\n' +
                'Enable DMs from server members:\n' +
                '1. Right-click the server name\n' +
                '2. Privacy Settings → Enable "Direct Messages"\n' +
                '3. Try again'
            );
            return;
        }

        // Send instructions in DM
        const role = await interaction.guild.roles.fetch(fullSession.role_id!);
        
        let dmDescription = `**Server:** ${interaction.guild.name}\n\n`;
        
        // Add role description if provided
        if (fullSession.role_description) {
            dmDescription += `**About this role:**\n${fullSession.role_description}\n\n`;
        }
        
        dmDescription +=
            '**Requirements:**\n' +
            `${fullSession.instructions}\n\n` +
            '**Instructions:**\n' +
            '1. Take a screenshot showing the required information\n' +
            '2. Upload it as an image in this DM\n' +
            '3. Staff will review and approve/deny your request\n\n' +
            '⚠️ Type `cancel` to cancel this verification.';
        
        const embed = new EmbedBuilder()
            .setTitle(`🎖️ ${role?.name || 'Role'} Verification`)
            .setDescription(dmDescription)
            .setColor(role?.color || 0x5865F2)
            .setFooter({ text: 'Upload your screenshot below' });

        // Add example image if provided
        if (fullSession.example_image_url) {
            embed.setImage(fullSession.example_image_url);
        }

        try {
            await dmChannel.send({ embeds: [embed] });
        } catch (err) {
            await interaction.editReply(
                '❌ **Cannot Send DM**\n\n' +
                'I couldn\'t send you a direct message. Please check your privacy settings and try again.'
            );
            return;
        }

        // Confirm in guild
        await interaction.editReply(
            '✅ Check your DMs for verification instructions!'
        );

        // Log verification start
        await logVerificationEvent(
            interaction.guild,
            interaction.user.id,
            `**[Custom Role] Verification started** for role <@&${fullSession.role_id}> - User clicked "Get Verified" button and received DM with screenshot instructions.`
        );

        // Start screenshot collector
        await collectScreenshot(dmChannel, session.id, interaction.user.id, interaction.guild.id);
    } catch (err) {
        console.error('[CustomRoleGetVerified] Error:', err);
        await interaction.editReply(
            '❌ An error occurred while starting verification. Please try again later.'
        );
    }
}

/**
 * Collect screenshot from user via DM
 */
async function collectScreenshot(
    dmChannel: DMChannel,
    sessionId: number,
    userId: string,
    guildId: string
): Promise<void> {
    const collector = dmChannel.createMessageCollector({
        filter: (m: Message) => m.author.id === userId && !m.author.bot && m.type === 0,
        time: MESSAGE_COLLECT_TIMEOUT,
    });

    collector.on('collect', async (message: Message) => {
        const input = message.content.trim().toLowerCase();

        // Check for cancel
        if (input === 'cancel') {
            collector.stop('cancelled');
            const cancelSession = await updateCustomRoleVerificationSession(sessionId, {
                status: 'cancelled',
            });
            await dmChannel.send(
                '❌ **Verification Cancelled**\n\n' +
                'You can restart verification anytime by clicking the "Get Verified" button in the server.'
            );
            return;
        }

        // Check for image attachment
        if (message.attachments.size === 0) {
            await dmChannel.send(
                '❌ **No Image Found**\n\n' +
                'Please upload a screenshot as an image attachment.\n' +
                'Type `cancel` to cancel verification.'
            );
            return;
        }

        const attachment = message.attachments.first()!;
        if (!attachment.contentType?.startsWith('image/')) {
            await dmChannel.send(
                '❌ **Invalid File Type**\n\n' +
                'Please upload an image file (PNG, JPG, etc.).\n' +
                'Type `cancel` to cancel verification.'
            );
            return;
        }

        // Screenshot is valid, update session
        collector.stop('success');

        try {
            const updatedSession = await updateCustomRoleVerificationSession(sessionId, {
                screenshot_url: attachment.url,
                status: 'pending_review',
            });

            await dmChannel.send(
                '✅ **Screenshot Submitted**\n\n' +
                'Your screenshot has been submitted for review.\n' +
                'Staff will review it and you\'ll be notified of the result here.'
            );

            // Get session with config data
            const fullSession = await getCustomRoleVerificationSession(sessionId);

            // Create verification ticket
            const guild = await dmChannel.client.guilds.fetch(guildId);
            await createVerificationTicket(guild, fullSession, userId);

            // Log submission
            await logVerificationEvent(
                guild,
                userId,
                `**[Custom Role] Screenshot submitted** for role <@&${fullSession.role_id}>\n**Screenshot:** [View](${attachment.url})\nWaiting for staff review...`
            );
        } catch (err) {
            console.error('[CustomRoleScreenshot] Error submitting:', err);
            await dmChannel.send(
                '❌ **Submission Failed**\n\n' +
                'An error occurred while submitting your screenshot. Please try again by clicking the "Get Verified" button in the server.'
            );
        }
    });

    collector.on('end', async (collected, reason) => {
        if (reason === 'time') {
            await dmChannel.send(
                '⏱️ **Verification Timed Out**\n\n' +
                'You took too long to submit a screenshot. Please click the "Get Verified" button in the server to try again.'
            );
            await updateCustomRoleVerificationSession(sessionId, { status: 'expired' });
        }
    });
}

/**
 * Create verification ticket in verification channel
 */
async function createVerificationTicket(
    guild: any,
    session: CustomRoleVerificationSession,
    userId: string
): Promise<void> {
    try {
        const verificationChannel = await guild.channels.fetch(session.verification_channel_id!) as TextChannel;
        const role = await guild.roles.fetch(session.role_id!);
        const user = await guild.client.users.fetch(userId);

        const embed = new EmbedBuilder()
            .setTitle('🎫 Custom Role Verification Request')
            .setDescription(
                `**User:** ${user.tag} (<@${userId}>)\n` +
                `**Role:** ${role}\n\n` +
                `**Requirements:**\n${session.instructions}`
            )
            .setImage(session.screenshot_url!)
            .setColor(role?.color || 0x5865F2)
            .setTimestamp()
            .setFooter({ text: `User ID: ${userId} | Session ID: ${session.id}` });

        const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`customrole:approve:${session.id}`)
                .setLabel('✅ Approve')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`customrole:deny:${session.id}`)
                .setLabel('❌ Deny')
                .setStyle(ButtonStyle.Danger)
        );

        const ticketMessage = await verificationChannel.send({
            embeds: [embed],
            components: [buttons],
        });

        // Update session with ticket message ID
        await updateCustomRoleVerificationSession(session.id, {
            ticket_message_id: ticketMessage.id,
        });
    } catch (err) {
        console.error('[CustomRoleTicket] Error creating ticket:', err);
    }
}

/**
 * Handle "Approve" button on ticket
 * customrole:approve:SESSION_ID
 */
export async function handleCustomRoleApprove(interaction: ButtonInteraction): Promise<void> {
    if (!interaction.inGuild() || !interaction.guild) {
        await interaction.reply({
            content: '❌ This button can only be used in a server.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const sessionId = parseInt(interaction.customId.split(':')[2]);

    const executed = await withButtonLock(interaction, `customrole_approve_${sessionId}`, async () => {
        await handleCustomRoleApproveInternal(interaction, sessionId);
    });

    if (!executed) {
        return;
    }
}

async function handleCustomRoleApproveInternal(interaction: ButtonInteraction, sessionId: number): Promise<void> {
    try {
        // Check if user has security+ role
        const member = await interaction.guild!.members.fetch(interaction.user.id);
        const hasPermission = await hasInternalRole(member, 'security');

        if (!hasPermission) {
            await interaction.reply({
                content: '❌ **Access Denied**\n\nYou need the Security+ role to approve verification requests.',
                ephemeral: true,
            });
            return;
        }

        await interaction.deferReply({ ephemeral: true });

        // Get session
        const session = await getCustomRoleVerificationSession(sessionId);

        if (session.status !== 'pending_review') {
            await interaction.editReply(
                `❌ **Invalid Status**\n\nThis verification request has already been ${session.status}.`
            );
            return;
        }

        // Update session to approved
        await updateCustomRoleVerificationSession(sessionId, {
            status: 'approved',
            reviewed_by_user_id: interaction.user.id,
        });

        // Grant role
        const targetMember = await interaction.guild!.members.fetch(session.user_id);
        const role = await interaction.guild!.roles.fetch(session.role_id!);

        if (!role) {
            await interaction.editReply(
                '❌ **Role Not Found**\n\nThe configured role no longer exists.'
            );
            return;
        }

        try {
            await targetMember.roles.add(role);
        } catch (err: any) {
            console.error('[CustomRoleApprove] Error granting role:', err);
            await interaction.editReply(
                `❌ **Failed to Grant Role**\n\n${err.message || 'Unknown error'}\n\nPlease check bot permissions and role hierarchy.`
            );
            return;
        }

        // Update ticket message
        const ticketEmbed = EmbedBuilder.from(interaction.message.embeds[0]);
        ticketEmbed.addFields(
            {
                name: '\u2705 Status',
                value: `**Approved** by ${interaction.user.tag}\n**Role granted:** ${role}`,
            }
        );
        ticketEmbed.setColor(0x00ff00);

        await interaction.message.edit({
            embeds: [ticketEmbed],
            components: [], // Remove buttons
        });

        // DM user
        try {
            const user = await interaction.client.users.fetch(session.user_id);
            await user.send(
                `✅ **Verification Approved!**\n\n` +
                `Your verification for **"${role.name}"** in **${interaction.guild!.name}** has been approved!\n` +
                `You now have the **"${role.name}"** role.`
            );
        } catch (err) {
            // User has DMs disabled, that's OK
        }

        // Log approval
        await logVerificationEvent(
            interaction.guild!,
            session.user_id,
            `**[Custom Role] Verification approved** by ${interaction.user} for role ${role}\nUser was granted the role successfully.`
        );

        await interaction.editReply(
            `✅ **Approved**\n\n<@${session.user_id}> has been granted the ${role} role.`
        );
    } catch (err) {
        console.error('[CustomRoleApprove] Error:', err);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: '❌ An error occurred while processing the approval.',
                ephemeral: true,
            });
        } else {
            await interaction.editReply('❌ An error occurred while processing the approval.');
        }
    }
}

/**
 * Handle "Deny" button on ticket
 * customrole:deny:SESSION_ID
 */
export async function handleCustomRoleDeny(interaction: ButtonInteraction): Promise<void> {
    if (!interaction.inGuild() || !interaction.guild) {
        await interaction.reply({
            content: '❌ This button can only be used in a server.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const sessionId = parseInt(interaction.customId.split(':')[2]);

    const executed = await withButtonLock(interaction, `customrole_deny_${sessionId}`, async () => {
        await handleCustomRoleDenyInternal(interaction, sessionId);
    });

    if (!executed) {
        return;
    }
}

async function handleCustomRoleDenyInternal(interaction: ButtonInteraction, sessionId: number): Promise<void> {
    try {
        // Check if user has security+ role
        const member = await interaction.guild!.members.fetch(interaction.user.id);
        const hasPermission = await hasInternalRole(member, 'security');

        if (!hasPermission) {
            await interaction.reply({
                content: '❌ **Access Denied**\n\nYou need the Security+ role to deny verification requests.',
                ephemeral: true,
            });
            return;
        }

        // Get session
        const session = await getCustomRoleVerificationSession(sessionId);

        if (session.status !== 'pending_review') {
            await interaction.reply({
                content: `❌ **Invalid Status**\n\nThis verification request has already been ${session.status}.`,
                ephemeral: true,
            });
            return;
        }

        // Show modal for denial reason
        const modal = new ModalBuilder()
            .setCustomId(`customrole:deny_modal:${sessionId}`)
            .setTitle('Deny Verification');

        const reasonInput = new TextInputBuilder()
            .setCustomId('reason')
            .setLabel('Denial Reason')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Explain why the verification was denied...')
            .setRequired(true)
            .setMaxLength(1000);

        const actionRow = new ActionRowBuilder<TextInputBuilder>().addComponents(reasonInput);
        modal.addComponents(actionRow);

        await interaction.showModal(modal);
    } catch (err) {
        console.error('[CustomRoleDeny] Error:', err);
        if (!interaction.replied) {
            await interaction.reply({
                content: '❌ An error occurred while processing the denial.',
                ephemeral: true,
            });
        }
    }
}

/**
 * Handle denial modal submission
 * customrole:deny_modal:SESSION_ID
 */
export async function handleCustomRoleDenyModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (!interaction.inGuild() || !interaction.guild) {
        await interaction.reply({
            content: '❌ This modal can only be used in a server.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
        const sessionId = parseInt(interaction.customId.split(':')[2]);
        const reason = interaction.fields.getTextInputValue('reason').trim();

        // Get session
        const session = await getCustomRoleVerificationSession(sessionId);

        if (session.status !== 'pending_review') {
            await interaction.editReply(
                `❌ **Invalid Status**\n\nThis verification request has already been ${session.status}.`
            );
            return;
        }

        // Update session to denied
        await updateCustomRoleVerificationSession(sessionId, {
            status: 'denied',
            reviewed_by_user_id: interaction.user.id,
            denial_reason: reason,
        });

        // Update ticket message
        const channel = interaction.channel as TextChannel;
        const ticketMessage = await channel.messages.fetch(session.ticket_message_id!);
        const ticketEmbed = EmbedBuilder.from(ticketMessage.embeds[0]);
        ticketEmbed.addFields(
            {
                name: '\u274c Status',
                value: `**Denied** by ${interaction.user.tag}\n**Reason:** ${reason}`,
            }
        );
        ticketEmbed.setColor(0xff0000);

        await ticketMessage.edit({
            embeds: [ticketEmbed],
            components: [], // Remove buttons
        });

        // DM user
        try {
            const user = await interaction.client.users.fetch(session.user_id);
            const role = await interaction.guild!.roles.fetch(session.role_id!);
            await user.send(
                `❌ **Verification Denied**\n\n` +
                `Your verification for **${role?.name || 'the role'}** in **${interaction.guild!.name}** has been denied.\n\n` +
                `**Reason:** ${reason}\n\n` +
                'You can try again by clicking the "Get Verified" button in the server.'
            );
        } catch (err) {
            // User has DMs disabled, that's OK
        }

        // Log denial
        const role = await interaction.guild!.roles.fetch(session.role_id!);
        await logVerificationEvent(
            interaction.guild!,
            session.user_id,
            `**[Custom Role] Verification denied** by ${interaction.user} for role ${role}\n**Reason:** ${reason}`,
            { error: true }
        );

        await interaction.editReply(
            `✅ **Denied**\n\nVerification denied. The user has been notified.`
        );
    } catch (err) {
        console.error('[CustomRoleDenyModal] Error:', err);
        await interaction.editReply('❌ An error occurred while processing the denial.');
    }
}
