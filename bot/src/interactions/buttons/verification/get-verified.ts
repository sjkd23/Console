// bot/src/interactions/buttons/verification/get-verified.ts
import {
    ButtonInteraction,
    MessageFlags,
    GuildMember,
    DMChannel,
    Message,
    ComponentType,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
} from 'discord.js';
import {
    getOrCreateSession,
    getSessionByUserId,
    updateSession,
    generateVerificationCode,
    checkRealmEyeVerification,
    applyVerification,
    validateIGN,
    createIgnRequestEmbed,
    createRealmEyeInstructionsEmbed,
    createRealmEyeButtons,
    createSuccessEmbed,
    createVerificationMethodButtons,
    createManualVerificationEmbed,
    createVerificationTicketEmbed,
    createVerificationTicketButtons,
    deleteSession,
    logVerificationEvent,
} from '../../../lib/verification/verification.js';
import { getJSON, getGuildVerificationConfig, getGuildChannels } from '../../../lib/utilities/http.js';

const MAX_IGN_ATTEMPTS = 3;
const MESSAGE_COLLECT_TIMEOUT = 5 * 60 * 1000; // 5 minutes

/**
 * Handle "Get Verified" button click
 * Starts the DM verification flow
 */
export async function handleGetVerified(interaction: ButtonInteraction): Promise<void> {
    if (!interaction.inGuild() || !interaction.guild) {
        await interaction.reply({
            content: '❌ This button can only be used in a server.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    // Acknowledge the button click
    await interaction.deferReply({ ephemeral: true });

    try {
        const member = await interaction.guild.members.fetch(interaction.user.id);

        // Check if user already has verified_raider role
        const rolesResponse = await getJSON<{ roles: Record<string, string | null> }>(
            `/guilds/${interaction.guildId}/roles`
        );
        const verifiedRaiderRoleId = rolesResponse.roles.verified_raider;

        if (verifiedRaiderRoleId && member.roles.cache.has(verifiedRaiderRoleId)) {
            await interaction.editReply(
                '✅ You\'re already verified! Contact staff if you need to update your IGN.'
            );
            return;
        }

        // Check if user already has an active verification session
        try {
            const existingSession = await getSessionByUserId(interaction.user.id);
            if (existingSession && 
                existingSession.status !== 'expired' && 
                existingSession.status !== 'verified' && 
                existingSession.status !== 'cancelled' &&
                existingSession.status !== 'denied') {
                await interaction.editReply(
                    `⚠️ You already have an active verification (status: ${existingSession.status}). ` +
                    'Complete or cancel it before starting a new one.'
                );
                return;
            }
        } catch (err) {
            // Session not found is OK, continue
        }

        // Try to open DM
        let dmChannel: DMChannel;
        try {
            dmChannel = await interaction.user.createDM();
        } catch (err) {
            await logVerificationEvent(
                interaction.guild,
                interaction.user.id,
                '**Failed to send DM** - User has DMs disabled from server members.',
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

        // Create or get session
        const session = await getOrCreateSession(interaction.guildId!, interaction.user.id);

        // Send initial DM with options
        const embed = new EmbedBuilder()
            .setTitle('🎮 Verification Started')
            .setDescription(
                `**Server:** ${interaction.guild.name}\n\n` +
                '**Choose your verification method:**\n\n' +
                '🔄 **RealmEye** - Automatic (add code to profile)\n' +
                '📷 **Manual Screenshot** - Submit vault screenshot with Discord tag\n\n' +
                'Click a button below.'
            )
            .setColor(0x00AE86)
            .setFooter({ text: 'Choose your method' });

        const buttons = createVerificationMethodButtons();
        
        try {
            await dmChannel.send({ 
                embeds: [embed],
                components: [buttons]
            });
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
            '**User clicked "Get Verified"** button and received DM with verification method options.'
        );

        // Don't start any collectors yet - wait for button click
    } catch (err) {
        console.error('[GetVerified] Error starting verification:', err);
        await interaction.editReply(
            '❌ An error occurred while starting verification. Please try again later.'
        );
    }
}

/**
 * Collect IGN from user via DM
 * This collector only listens for TEXT MESSAGES and will not interfere with button interactions
 */
async function collectIGN(
    dmChannel: DMChannel,
    guildId: string,
    userId: string,
    guildName: string,
    member: GuildMember
): Promise<void> {
    let attempts = 0;

    const collector = dmChannel.createMessageCollector({
        filter: (m: Message) => m.author.id === userId && !m.author.bot && m.type === 0, // Only text messages
        time: MESSAGE_COLLECT_TIMEOUT,
    });

    collector.on('collect', async (message: Message) => {
        const input = message.content.trim();

        // Check for cancel
        if (input.toLowerCase() === 'cancel') {
            collector.stop('cancelled');
            await updateSession(guildId, userId, { status: 'cancelled' });
            await dmChannel.send(
                '❌ **Verification Cancelled**\n\n' +
                'You can restart verification anytime by clicking the "Get Verified" button in the server.'
            );
            return;
        }

        // Validate IGN
        const validation = validateIGN(input);
        if (!validation.valid) {
            attempts++;
            if (attempts >= MAX_IGN_ATTEMPTS) {
                collector.stop('max_attempts');
                await dmChannel.send(
                    '❌ **Too Many Invalid Attempts**\n\n' +
                    'Verification cancelled due to too many invalid IGN submissions.\n' +
                    'Please click the "Get Verified" button in the server to try again.'
                );
                await updateSession(guildId, userId, { status: 'cancelled' });
                return;
            }

            await dmChannel.send(
                `❌ **Invalid IGN**: ${validation.error}\n\n` +
                `Attempts remaining: ${MAX_IGN_ATTEMPTS - attempts}\n` +
                'Please try again or type "cancel" to stop.'
            );
            return;
        }

        // IGN is valid, generate verification code
        collector.stop('success');
        
        const code = generateVerificationCode();
        await updateSession(guildId, userId, {
            rotmg_ign: input,
            verification_code: code,
            status: 'pending_realmeye',
        });

        // Log IGN submission
        const guild = member.guild;
        await logVerificationEvent(
            guild,
            userId,
            `**IGN submitted:** \`${input}\`\n**Verification code generated:** \`${code}\`\nWaiting for user to add code to RealmEye profile...`
        );

        // Fetch guild config for custom RealmEye instructions image
        const config = await getGuildVerificationConfig(guildId);

        // Send RealmEye instructions
        const instructionsEmbed = createRealmEyeInstructionsEmbed(
            input, 
            code, 
            guildName,
            config.realmeye_instructions_image
        );
        const buttons = createRealmEyeButtons();

        await dmChannel.send({
            embeds: [instructionsEmbed],
            components: [buttons],
        });
    });

    collector.on('end', async (collected, reason) => {
        if (reason === 'time') {
            await dmChannel.send(
                '⏱️ **Verification Timed Out**\n\n' +
                'You took too long to respond. Please click the "Get Verified" button in the server to try again.'
            );
            await updateSession(guildId, userId, { status: 'expired' });
        }
    });
}

/**
 * Handle "Done" button - check RealmEye for verification code
 */
export async function handleVerificationDone(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferReply();

    try {
        // Get session by user ID (works in DMs where guildId is null)
        const session = await getSessionByUserId(interaction.user.id);

        if (!session) {
            await interaction.editReply(
                '❌ **Session Error**\n\n' +
                'No active verification session was found. Please restart verification from the server.'
            );
            return;
        }

        if (session.status !== 'pending_realmeye') {
            await interaction.editReply(
                '❌ **Invalid State**\n\n' +
                'Your verification session is not in the correct state. Please restart verification.'
            );
            return;
        }

        if (!session.rotmg_ign || !session.verification_code) {
            await interaction.editReply(
                '❌ **Session Error**\n\n' +
                'Verification data is missing. Please restart verification.'
            );
            return;
        }

        // Extract guildId from session
        const guildId = session.guild_id;

        // Get guild for logging
        const guild = interaction.client.guilds.cache.get(guildId);

        // Check RealmEye
        await interaction.editReply(
            '🔍 **Checking RealmEye...**\n\n' +
            `Looking for verification code in ${session.rotmg_ign}'s profile...`
        );

        // Log checking attempt
        if (guild) {
            await logVerificationEvent(
                guild,
                interaction.user.id,
                `**Checking RealmEye** for IGN \`${session.rotmg_ign}\`...`
            );
        }

        const result = await checkRealmEyeVerification(session.rotmg_ign, session.verification_code);

        if (result.error) {
            if (guild) {
                await logVerificationEvent(
                    guild,
                    interaction.user.id,
                    `**RealmEye check failed:** ${result.error}`,
                    { error: true }
                );
            }
            await interaction.editReply(
                `❌ **Error**: ${result.error}\n\n` +
                'Please fix the issue and click **Done** again.'
            );
            return;
        }

        if (!result.found) {
            if (guild) {
                await logVerificationEvent(
                    guild,
                    interaction.user.id,
                    `**Code not found** in RealmEye profile yet. User will retry.`
                );
            }
            await interaction.editReply(
                '❌ **Code Not Found**\n\n' +
                `I couldn't find the verification code in your RealmEye description yet.\n\n` +
                '**Please make sure:**\n' +
                '• You added the code to your **description** (not name or guild)\n' +
                '• You saved your RealmEye profile\n' +
                '• The code is exactly: `' + session.verification_code + '`\n\n' +
                'Wait a few seconds for RealmEye to update, then click **Done** again.'
            );
            return;
        }

        // Code found! Apply verification
        await interaction.editReply(
            '✅ **Code Found!**\n\n' +
            'Applying verification...'
        );

        // Log success
        if (guild) {
            await logVerificationEvent(
                guild,
                interaction.user.id,
                `**✅ Code found on RealmEye!** Applying verification...`
            );
        }

        // Get guild and member using guildId from session
        if (!guild) {
            await interaction.editReply('❌ Could not find guild. Please contact staff.');
            return;
        }

        const member = await guild.members.fetch(interaction.user.id);
        const applyResult = await applyVerification(
            guild,
            member,
            session.rotmg_ign,
            interaction.user.id,
            member // User is verifying themselves
        );

        // Mark session as verified
        await updateSession(guildId, interaction.user.id, { status: 'verified' });

        // Log completion
        await logVerificationEvent(
            guild,
            interaction.user.id,
            `**✅ Verification Complete!**\n` +
            `• IGN: \`${session.rotmg_ign}\`\n` +
            `• Role Applied: ${applyResult.roleApplied ? '✅' : '❌'}\n` +
            `• Nickname Set: ${applyResult.nicknameSet ? '✅' : '❌'}` +
            (applyResult.errors.length > 0 ? `\n• Errors: ${applyResult.errors.join(', ')}` : '')
        );

        // Send success message
        const successEmbed = createSuccessEmbed(
            guild.name,
            session.rotmg_ign,
            applyResult.roleApplied,
            applyResult.nicknameSet,
            applyResult.errors
        );

        await interaction.editReply({
            content: null,
            embeds: [successEmbed],
            components: [], // Remove buttons
        });

        // Clean up session after a delay
        setTimeout(() => {
            deleteSession(guildId, interaction.user.id).catch(console.error);
        }, 60000); // 1 minute
    } catch (err) {
        console.error('[VerificationDone] Error:', err);
        await interaction.editReply(
            '❌ An unexpected error occurred. Please try again or contact staff.'
        );
    }
}

/**
 * Handle "Cancel" button - cancel verification flow
 */
export async function handleVerificationCancel(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferReply();

    try {
        // Get session by user ID (works in DMs where guildId is null)
        const session = await getSessionByUserId(interaction.user.id);

        if (!session) {
            await interaction.editReply({
                content:
                    '❌ **No Active Session**\n\n' +
                    'No active verification session found. If you want to verify again, click the "Get Verified" button in the server.',
                components: [],
            });
            return;
        }

        // Extract guildId from session
        const guildId = session.guild_id;

        await updateSession(guildId, interaction.user.id, { status: 'cancelled' });

        await interaction.editReply({
            content:
                '❌ **Verification Cancelled**\n\n' +
                'You can restart verification anytime by clicking the "Get Verified" button in the server.',
            components: [], // Remove buttons
        });

        // Clean up session
        setTimeout(() => {
            deleteSession(guildId, interaction.user.id).catch(console.error);
        }, 5000);
    } catch (err) {
        console.error('[VerificationCancel] Error:', err);
        await interaction.editReply(
            '❌ An error occurred. Your verification session may still be active.'
        );
    }
}

/**
 * Handle "RealmEye" button - start automatic verification via RealmEye
 */
export async function handleRealmEyeVerification(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferReply();

    try {
        // Get session by user ID (works in DMs)
        const session = await getSessionByUserId(interaction.user.id);

        if (!session) {
            await interaction.editReply(
                '❌ **Session Error**\n\n' +
                'No active verification session found. Please restart verification from the server.'
            );
            return;
        }

        if (session.status !== 'pending_ign') {
            await interaction.editReply(
                '❌ **Invalid State**\n\n' +
                `Your verification session is currently: ${session.status}\n` +
                'Please restart verification if needed.'
            );
            return;
        }

        const guildId = session.guild_id;

        // Get DM channel and guild
        const dmChannel = await interaction.user.createDM();
        const guild = interaction.client.guilds.cache.get(guildId);
        if (!guild) {
            await interaction.editReply('❌ Could not find guild. Please contact staff.');
            return;
        }

        const member = await guild.members.fetch(interaction.user.id);

        await interaction.editReply(
            '🔄 **RealmEye Verification Selected**\n\n' +
            'Please type your in-game name (IGN) in the next message.'
        );

        // Log method selection
        await logVerificationEvent(
            guild,
            interaction.user.id,
            '**User selected RealmEye verification** method. Waiting for IGN input...'
        );

        // Send IGN request
        const embed = createIgnRequestEmbed(guild.name);
        await dmChannel.send({ embeds: [embed] });

        // Start IGN collection
        collectIGN(dmChannel, guildId, interaction.user.id, guild.name, member);
    } catch (err) {
        console.error('[RealmEyeVerification] Error:', err);
        await interaction.editReply(
            '❌ An unexpected error occurred. Please try again or contact staff.'
        );
    }
}

/**
 * Handle "Manual Verify Screenshot" button - start manual verification flow
 */
export async function handleManualVerifyScreenshot(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferReply();

    try {
        // Get session by user ID (works in DMs)
        const session = await getSessionByUserId(interaction.user.id);

        if (!session) {
            await interaction.editReply(
                '❌ **Session Error**\n\n' +
                'No active verification session found. Please restart verification from the server.'
            );
            return;
        }

        // Allow switching to manual from initial state
        if (session.status !== 'pending_ign') {
            await interaction.editReply(
                '❌ **Invalid State**\n\n' +
                `Your verification session is currently: ${session.status}\n` +
                'Please restart verification if you want to try manual verification.'
            );
            return;
        }

        const guildId = session.guild_id;

        // Get DM channel
        const dmChannel = await interaction.user.createDM();

        // Get guild name and custom instructions
        const guild = interaction.client.guilds.cache.get(guildId);
        if (!guild) {
            await interaction.editReply('❌ Could not find guild. Please contact staff.');
            return;
        }

        // Fetch custom instructions from guild config
        const config = await getGuildVerificationConfig(guildId);

        await interaction.editReply(
            '📷 **Manual Verification Selected**\n\n' +
            'Please upload your screenshot as instructed.'
        );

        // Log method selection
        await logVerificationEvent(
            guild,
            interaction.user.id,
            '**User selected Manual Screenshot verification** method. Waiting for screenshot upload...'
        );

        // Update session to manual verification mode
        await updateSession(guildId, interaction.user.id, {
            verification_method: 'manual',
            status: 'pending_screenshot',
        });

        // Send screenshot instructions
        const embed = createManualVerificationEmbed(
            guild.name, 
            config.manual_verify_instructions,
            config.manual_verify_instructions_image
        );
        const cancelButton = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId('verification:cancel')
                .setLabel('Cancel')
                .setEmoji('❌')
                .setStyle(ButtonStyle.Danger)
        );

        await dmChannel.send({
            embeds: [embed],
            components: [cancelButton],
        });

        // Start screenshot collection (no IGN needed)
        collectScreenshot(dmChannel, guildId, interaction.user.id, guild.name);
    } catch (err) {
        console.error('[ManualVerifyScreenshot] Error:', err);
        await interaction.editReply(
            '❌ An unexpected error occurred. Please try again or contact staff.'
        );
    }
}

/**
 * Collect screenshot from user for manual verification
 */
async function collectScreenshot(
    dmChannel: DMChannel,
    guildId: string,
    userId: string,
    guildName: string
): Promise<void> {
    const collector = dmChannel.createMessageCollector({
        filter: (m: Message) => m.author.id === userId && !m.author.bot,
        time: MESSAGE_COLLECT_TIMEOUT,
    });

    collector.on('collect', async (message: Message) => {
        // Check for cancel
        if (message.content.trim().toLowerCase() === 'cancel') {
            collector.stop('cancelled');
            await updateSession(guildId, userId, { status: 'cancelled' });
            await dmChannel.send(
                '❌ **Verification Cancelled**\n\n' +
                'You can restart verification anytime by clicking the "Get Verified" button in the server.'
            );
            return;
        }

        // Check if message has an image attachment
        const attachment = message.attachments.find(
            att => att.contentType?.startsWith('image/')
        );

        if (!attachment) {
            await dmChannel.send(
                '❌ **Invalid Submission**\n\n' +
                'Please send a valid image file (PNG, JPG, etc.).\n' +
                'Make sure to attach the screenshot, not send text.'
            );
            return;
        }

        // Valid screenshot received
        collector.stop('success');

        const guild = dmChannel.client.guilds.cache.get(guildId);

        await dmChannel.send(
            '✅ **Screenshot Received**\n\n' +
            'Your screenshot has been submitted for review by security+.\n' +
            'You will receive a DM when your verification is approved or denied.\n\n' +
            '**Note:** Security+ will provide your IGN when approving your request.'
        );

        // Log screenshot submission
        if (guild) {
            await logVerificationEvent(
                guild,
                userId,
                `**Screenshot submitted** for manual verification. Creating ticket for Security+ review...`
            );
        }

        // Update session with screenshot (no IGN yet)
        await updateSession(guildId, userId, {
            screenshot_url: attachment.url,
            status: 'pending_review',
        });

        // Create ticket in manual-verification channel
        try {
            const { channels } = await getGuildChannels(guildId);
            const manualVerificationChannelId = channels.manual_verification;

            if (!manualVerificationChannelId) {
                console.error('[ManualVerification] No manual-verification channel configured');
                if (guild) {
                    await logVerificationEvent(
                        guild,
                        userId,
                        '**❌ Error:** No manual verification channel configured in server.',
                        { error: true }
                    );
                }
                await dmChannel.send(
                    '⚠️ **Configuration Error**\n\n' +
                    'The server has not configured a manual verification channel.\n' +
                    'Please contact a staff member.'
                );
                return;
            }

            if (!guild) return;

            const channel = await guild.channels.fetch(manualVerificationChannelId);
            if (!channel || !channel.isTextBased()) {
                console.error('[ManualVerification] Invalid manual-verification channel');
                return;
            }

            // Fetch user to get their Discord tag
            const user = await guild.client.users.fetch(userId);
            
            // Send ticket (no IGN yet, staff will provide it)
            const ticketEmbed = createVerificationTicketEmbed(userId, attachment.url, user.tag);
            const ticketButtons = createVerificationTicketButtons(userId);

            const ticketMessage = await channel.send({
                embeds: [ticketEmbed],
                components: [ticketButtons],
            });

            // Update session with ticket message ID
            await updateSession(guildId, userId, {
                ticket_message_id: ticketMessage.id,
            });

            // Log ticket creation
            await logVerificationEvent(
                guild,
                userId,
                `**Verification ticket created** in <#${manualVerificationChannelId}>. Awaiting Security+ approval.`
            );
        } catch (err) {
            console.error('[ManualVerification] Error creating ticket:', err);
            await dmChannel.send(
                '❌ **Error**\n\n' +
                'Failed to create verification ticket. Please contact a staff member.'
            );
        }
    });

    collector.on('end', async (collected, reason) => {
        if (reason === 'time') {
            await dmChannel.send(
                '⏱️ **Verification Timed Out**\n\n' +
                'You took too long to submit your screenshot. Please click the "Get Verified" button in the server to try again.'
            );
            await updateSession(guildId, userId, { status: 'expired' });
        }
    });
}
