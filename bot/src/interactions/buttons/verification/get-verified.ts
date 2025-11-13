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
    deleteSession,
} from '../../../lib/verification.js';
import { getJSON } from '../../../lib/http.js';

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
                '✅ You are already verified in this server!\n\n' +
                'If you need to update your IGN or have other issues, please contact a staff member.'
            );
            return;
        }

        // Try to open DM
        let dmChannel: DMChannel;
        try {
            dmChannel = await interaction.user.createDM();
        } catch (err) {
            await interaction.editReply(
                '❌ **Cannot Send DM**\n\n' +
                'I couldn\'t send you a direct message. Please enable DMs from server members:\n' +
                '1. Right-click the server name\n' +
                '2. Go to Privacy Settings\n' +
                '3. Enable "Direct Messages"\n\n' +
                'Then click the "Get Verified" button again.'
            );
            return;
        }

        // Create or get session
        const session = await getOrCreateSession(interaction.guildId!, interaction.user.id);

        // Send initial DM with Cancel button
        const embed = createIgnRequestEmbed(interaction.guild.name);
        const cancelButton = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId('verification:cancel')
                .setLabel('Cancel Verification')
                .setEmoji('❌')
                .setStyle(ButtonStyle.Danger)
        );
        
        try {
            await dmChannel.send({ 
                embeds: [embed],
                components: [cancelButton]
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
            '✅ **Verification Started!**\n\n' +
            'Check your DMs for verification instructions.\n\n' +
            'If you don\'t see a message from me, please check your privacy settings.'
        );

        // Start IGN collection flow in DM
        await collectIGN(dmChannel, interaction.guildId!, interaction.user.id, interaction.guild.name, member);
    } catch (err) {
        console.error('[GetVerified] Error starting verification:', err);
        await interaction.editReply(
            '❌ An error occurred while starting verification. Please try again later.'
        );
    }
}

/**
 * Collect IGN from user via DM
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
        filter: (m: Message) => m.author.id === userId && !m.author.bot,
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

        // Send RealmEye instructions
        const instructionsEmbed = createRealmEyeInstructionsEmbed(input, code, guildName);
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

        // Check RealmEye
        await interaction.editReply(
            '🔍 **Checking RealmEye...**\n\n' +
            `Looking for verification code in ${session.rotmg_ign}'s profile...`
        );

        const result = await checkRealmEyeVerification(session.rotmg_ign, session.verification_code);

        if (result.error) {
            await interaction.editReply(
                `❌ **Error**: ${result.error}\n\n` +
                'Please fix the issue and click **Done** again.'
            );
            return;
        }

        if (!result.found) {
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

        // Get guild and member using guildId from session
        const guild = interaction.client.guilds.cache.get(guildId);
        if (!guild) {
            await interaction.editReply('❌ Could not find guild. Please contact staff.');
            return;
        }

        const member = await guild.members.fetch(interaction.user.id);
        const applyResult = await applyVerification(
            guild,
            member,
            session.rotmg_ign,
            interaction.user.id
        );

        // Mark session as verified
        await updateSession(guildId, interaction.user.id, { status: 'verified' });

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
