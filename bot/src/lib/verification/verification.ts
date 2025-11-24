// bot/src/lib/verification.ts
/**
 * RealmEye verification service
 * Handles DM-based verification flow:
 * 1. Session management
 * 2. Verification code generation
 * 3. RealmEye profile checking
 * 4. Role and nickname application
 */

import { GuildMember, User, Guild, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { postJSON, getJSON, patchJSON, verifyRaider, BackendError } from '../utilities/http.js';
import { getGuildChannels } from '../utilities/http.js';
import crypto from 'crypto';

// ===== TYPES =====

export type VerificationStatus = 
    | 'pending_ign' 
    | 'pending_realmeye'
    | 'pending_screenshot'
    | 'pending_review'
    | 'verified' 
    | 'cancelled'
    | 'denied'
    | 'expired';

export interface VerificationSession {
    guild_id: string;
    user_id: string;
    rotmg_ign: string | null;
    verification_code: string | null;
    status: VerificationStatus;
    verification_method: 'realmeye' | 'manual';
    screenshot_url: string | null;
    ticket_message_id: string | null;
    reviewed_by_user_id: string | null;
    reviewed_at: string | null;
    denial_reason: string | null;
    created_at: string;
    updated_at: string;
    expires_at: string;
}

// ===== SESSION MANAGEMENT =====

/**
 * Get the most recent active verification session for a user (across all guilds)
 * Used for DM-based interactions where guildId is not available
 */
export async function getSessionByUserId(userId: string): Promise<VerificationSession | null> {
    try {
        const session = await getJSON<VerificationSession>(
            `/verification/session/user/${userId}`
        );
        return session;
    } catch (err) {
        // Session doesn't exist or is expired
        if (err instanceof BackendError && err.status === 404) {
            return null;
        }
        throw err;
    }
}

/**
 * Create or retrieve a verification session for a user in a guild
 */
export async function getOrCreateSession(
    guildId: string,
    userId: string
): Promise<VerificationSession> {
    try {
        // Try to get existing session
        const session = await getJSON<VerificationSession>(
            `/verification/session/${guildId}/${userId}`
        );
        
        // If session exists but is expired or completed, create a new one
        if (session.status === 'expired' || session.status === 'verified' || session.status === 'cancelled') {
            return await createSession(guildId, userId);
        }
        
        return session;
    } catch (err) {
        // Session doesn't exist, create new one
        if (err instanceof BackendError && err.status === 404) {
            return await createSession(guildId, userId);
        }
        throw err;
    }
}

/**
 * Create a new verification session
 */
async function createSession(guildId: string, userId: string): Promise<VerificationSession> {
    return await postJSON<VerificationSession>('/verification/session', {
        guild_id: guildId,
        user_id: userId,
    });
}

/**
 * Update a verification session
 */
export async function updateSession(
    guildId: string,
    userId: string,
    updates: {
        rotmg_ign?: string;
        verification_code?: string;
        status?: VerificationStatus;
        verification_method?: 'realmeye' | 'manual';
        screenshot_url?: string;
        ticket_message_id?: string;
        reviewed_by_user_id?: string;
        denial_reason?: string;
    }
): Promise<VerificationSession> {
    return await patchJSON<VerificationSession>(
        `/verification/session/${guildId}/${userId}`,
        updates
    );
}

/**
 * Delete a verification session
 */
export async function deleteSession(guildId: string, userId: string): Promise<void> {
    await fetch(`${process.env.BACKEND_URL}/verification/session/${guildId}/${userId}`, {
        method: 'DELETE',
        headers: {
            'content-type': 'application/json',
            'x-api-key': process.env.BACKEND_API_KEY || '',
        },
    });
}

// ===== CODE GENERATION =====

/**
 * Generate a random alphanumeric verification code
 * @param length Length of the code (default: 20)
 */
export function generateVerificationCode(length: number = 20): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'; // Exclude confusing chars like I, l, 1, 0, O
    const bytes = crypto.randomBytes(length);
    let code = '';
    
    for (let i = 0; i < length; i++) {
        code += chars[bytes[i] % chars.length];
    }
    
    return code;
}

// ===== REALMEYE CHECKING =====

/**
 * Check if a verification code exists in a RealmEye profile description.
 * 
 * This function now delegates to the centralized RealmEye scraper module,
 * which provides clean, DRY, and robust HTML parsing inspired by RealmEyeSharper.
 * 
 * @param ign The in-game name to check
 * @param code The verification code to look for
 * @returns Object with success status and profile data (maintains backward compatibility)
 */
export async function checkRealmEyeVerification(
    ign: string,
    code: string
): Promise<{
    found: boolean;
    description?: string;
    profileExists?: boolean;
    error?: string;
}> {
    // Use the new centralized RealmEye scraper
    const { fetchRealmEyePlayerProfile } = await import('../../services/realmeye/index.js');
    
    console.log(`[Verification] Checking RealmEye for IGN: "${ign}", looking for code: "${code}"`);
    
    const profile = await fetchRealmEyePlayerProfile(ign);

    console.log(`[Verification] RealmEye result:`, {
        resultCode: profile.resultCode,
        descriptionLinesCount: profile.descriptionLines.length,
        descriptionLines: profile.descriptionLines,
    });

    // Map result codes to the existing return format for backward compatibility
    switch (profile.resultCode) {
        case 'Success': {
            // Join description lines into a single string for the legacy format
            const description = profile.descriptionLines.join('\n');
            console.log(`[Verification] Full description: "${description}"`);
            console.log(`[Verification] Looking for code: "${code}"`);
            
            const found = description.includes(code);

            if (found) {
                console.log('[Verification] ✅ Code found in description!');
            } else {
                console.log('[Verification] ❌ Code NOT found in description');
                console.log('[Verification] Description length:', description.length);
                console.log('[Verification] Code length:', code.length);
            }

            return {
                found,
                profileExists: true,
                description,
            };
        }

        case 'NotFound':
            return {
                found: false,
                profileExists: false,
                error: profile.errorMessage || `RealmEye profile for "${ign}" not found.`,
            };

        case 'Private':
            return {
                found: false,
                profileExists: true,
                error: profile.errorMessage || `The RealmEye profile for "${ign}" is private.`,
            };

        case 'ServiceUnavailable':
            return {
                found: false,
                error: profile.errorMessage || 'Failed to connect to RealmEye. Please try again later.',
            };

        case 'Error':
        default:
            return {
                found: false,
                error: profile.errorMessage || 'An unexpected error occurred while checking RealmEye.',
            };
    }
}

// ===== ROLE AND NICKNAME APPLICATION =====

/**
 * Apply verification to a member: grant role and set nickname
 */
export async function applyVerification(
    guild: Guild,
    member: GuildMember,
    ign: string,
    actorUserId: string,
    actorMember?: GuildMember
): Promise<{
    success: boolean;
    roleApplied: boolean;
    nicknameSet: boolean;
    errors: string[];
}> {
    const errors: string[] = [];
    let roleApplied = false;
    let nicknameSet = false;

    try {
        // Get guild config to find verified_raider role
        const { channels } = await getGuildChannels(guild.id);
        
        // We need to get the role from guild_role mapping
        // Use the existing http helper pattern
        const rolesResponse = await getJSON<{ roles: Record<string, string | null> }>(
            `/guilds/${guild.id}/roles`
        );
        
        const verifiedRaiderRoleId = rolesResponse.roles.verified_raider;

        if (!verifiedRaiderRoleId) {
            errors.push(
                'Verified Raider role is not configured for this server. Please ask a Moderator to configure it using `/setroles`.'
            );
            return { success: false, roleApplied, nicknameSet, errors };
        }

        // Try to add role
        try {
            const role = await guild.roles.fetch(verifiedRaiderRoleId);
            if (!role) {
                errors.push(
                    `Verified Raider role (ID: ${verifiedRaiderRoleId}) no longer exists. Please ask a Moderator to reconfigure it.`
                );
            } else {
                await member.roles.add(role);
                roleApplied = true;
            }
        } catch (roleErr: any) {
            if (roleErr.code === 50013) {
                errors.push(
                    'Bot lacks permission to assign roles. Please ask a server admin to check bot permissions and role hierarchy.'
                );
            } else {
                errors.push(`Failed to assign Verified Raider role: ${roleErr.message}`);
            }
        }

        // Try to set nickname
        try {
            await member.setNickname(ign);
            nicknameSet = true;
        } catch (nickErr: any) {
            if (nickErr.code === 50013) {
                errors.push(
                    'Bot lacks permission to change your nickname. This is usually because you have a higher role than the bot.'
                );
            } else {
                errors.push(`Failed to set nickname: ${nickErr.message}`);
            }
        }

        // Call backend to record verification
        try {
            // Get actor's roles if actorMember is provided
            const actorRoles = actorMember ? Array.from(actorMember.roles.cache.keys()) : undefined;
            
            await verifyRaider({
                actor_user_id: actorUserId,
                actor_roles: actorRoles,
                guild_id: guild.id,
                user_id: member.id,
                ign,
            });
        } catch (backendErr) {
            console.error('[Verification] Failed to record verification in backend:', backendErr);
            // Don't add to user-facing errors since Discord changes succeeded
            errors.push('Verification recorded in Discord but may not be saved in database');
        }

        return {
            success: roleApplied || nicknameSet,
            roleApplied,
            nicknameSet,
            errors,
        };
    } catch (err) {
        console.error('[Verification] Error applying verification:', err);
        errors.push('An unexpected error occurred while applying verification.');
        return { success: false, roleApplied, nicknameSet, errors };
    }
}

// ===== VALIDATION =====

/**
 * Validate an IGN
 */
export function validateIGN(ign: string): { valid: boolean; error?: string } {
    const trimmed = ign.trim();
    
    if (trimmed.length === 0) {
        return { valid: false, error: 'IGN cannot be empty.' };
    }
    
    if (trimmed.length > 16) {
        return { valid: false, error: 'IGN must be 16 characters or less.' };
    }
    
    if (!/^[A-Za-z0-9 _-]+$/.test(trimmed)) {
        return { valid: false, error: 'IGN can only contain letters, numbers, spaces, hyphens, and underscores.' };
    }
    
    return { valid: true };
}

// ===== UI BUILDERS =====

/**
 * Create the "Get Verified" panel embed
 */
export function createVerificationPanelEmbed(customMessage?: string | null, imageUrl?: string | null): EmbedBuilder {
    const description = 
        '**Get verified to join raids and access server features.**\n\n' +
        (customMessage ? `${customMessage}\n\n` : '') +
        '**How it works:**\n' +
        '1️⃣ Click **"Get Verified"** below\n' +
        '2️⃣ Follow the DM instructions\n' +
        '3️⃣ Choose RealmEye (automatic) or screenshot (manual)\n' +
        '4️⃣ Get the Verified Raider role!\n\n' +
        '**Requirements:**\n' +
        '• DMs enabled\n' +
        '• For automatic: Public RealmEye profile\n' +
        '• For manual: Screenshot of vault with Discord tag in chat';

    const embed = new EmbedBuilder()
        .setTitle('🎯 Get Verified')
        .setDescription(description)
        .setColor(0x00AE86)
        .setFooter({ text: 'Need help? Contact staff' });

    if (imageUrl) {
        embed.setImage(imageUrl);
    }

    return embed;
}

/**
 * Create the "Get Verified" button
 */
export function createVerificationPanelButton(): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId('verification:get_verified')
            .setLabel('Get Verified')
            .setEmoji('✅')
            .setStyle(ButtonStyle.Success)
    );
}

/**
 * Create DM embed for IGN request
 */
export function createIgnRequestEmbed(guildName: string): EmbedBuilder {
    return new EmbedBuilder()
        .setTitle('🎮 Verification Started')
        .setDescription(
            `**Server:** ${guildName}\n\n` +
            '**Step 1: What\'s your ROTMG IGN?**\n\n' +
            'Reply with your in-game name exactly as it appears on RealmEye.\n\n' +
            '**Note:** Your profile must be public on RealmEye.'
        )
        .setColor(0x00AE86)
        .setFooter({ text: 'Type your IGN in the next message' });
}

/**
 * Create DM embed for RealmEye code instructions
 */
export function createRealmEyeInstructionsEmbed(
    ign: string,
    code: string,
    guildName: string,
    imageUrl?: string | null
): EmbedBuilder {
    const embed = new EmbedBuilder()
        .setTitle('📝 Add Code to RealmEye')
        .setDescription(
            `**Server:** ${guildName}\n` +
            `**IGN:** ${ign}\n\n` +
            '**Step 2: Add this code to your RealmEye description:**\n\n' +
            `\`\`\`\n${code}\n\`\`\`\n\n` +
            '**Instructions:**\n' +
            `1. Go to https://www.realmeye.com/player/${encodeURIComponent(ign)}\n` +
            '2. Edit your profile description\n' +
            '3. Paste the code above\n' +
            '4. Save your profile\n' +
            '5. Click **Done** below\n\n' +
            '**Note:** Code must be in your description, not name or guild.'
        )
        .setColor(0x00AE86)
        .setFooter({ text: 'Expires in 1 hour' });

    if (imageUrl) {
        embed.setImage(imageUrl);
    }

    return embed;
}

/**
 * Create buttons for RealmEye verification step
 */
export function createRealmEyeButtons(guildId: string): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`verification:done:${guildId}`)
            .setLabel('Done')
            .setEmoji('✅')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`verification:cancel:${guildId}`)
            .setLabel('Cancel')
            .setEmoji('❌')
            .setStyle(ButtonStyle.Danger)
    );
}

/**
 * Create verification method selection buttons
 */
export function createVerificationMethodButtons(guildId: string): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`verification:realmeye:${guildId}`)
            .setLabel('RealmEye')
            .setEmoji('🔄')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`verification:manual_screenshot:${guildId}`)
            .setLabel('Manual Screenshot')
            .setEmoji('📷')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`verification:cancel:${guildId}`)
            .setLabel('Cancel')
            .setEmoji('❌')
            .setStyle(ButtonStyle.Danger)
    );
}

/**
 * Create manual verification screenshot request embed
 */
export function createManualVerificationEmbed(
    guildName: string,
    customInstructions?: string | null,
    imageUrl?: string | null
): EmbedBuilder {
    const defaultInstructions = 
        '**Send a screenshot showing:**\n\n' +
        '1️⃣ Your vault or character screen\n' +
        '2️⃣ Your Discord tag in the chat\n' +
        '3️⃣ Your IGN clearly visible\n\n' +
        '**Example:** Open vault, type Discord tag in chat, screenshot it.\n\n' +
        '⚠️ **Screenshot must be clear and unedited.**';

    const embed = new EmbedBuilder()
        .setTitle('📷 Manual Verification')
        .setDescription(
            `**Server:** ${guildName}\n\n` +
            (customInstructions || defaultInstructions)
        )
        .setColor(0xFFA500)
        .setFooter({ text: 'Send your screenshot next' });

    if (imageUrl) {
        embed.setImage(imageUrl);
    }

    return embed;
}

/**
 * Create verification ticket embed for security+ review
 */
export function createVerificationTicketEmbed(
    userId: string,
    screenshotUrl: string,
    userTag?: string
): EmbedBuilder {
    return new EmbedBuilder()
        .setTitle('🎫 Manual Verification Request')
        .setDescription(
            `**User:** <@${userId}>\n` +
            `**Discord Tag:** ${userTag || 'Unknown'}\n` +
            `**User ID:** ${userId}\n\n` +
            '**Screenshot submitted for review:**\n' +
            '⚠️ **Staff must provide the IGN when approving**'
        )
        .setImage(screenshotUrl)
        .setColor(0xFFA500)
        .setTimestamp()
        .setFooter({ text: 'Security+ can approve or deny this request' });
}

/**
 * Create approve/deny buttons for verification ticket
 */
export function createVerificationTicketButtons(userId: string): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`verification:approve:${userId}`)
            .setLabel('Approve')
            .setEmoji('✅')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`verification:deny:${userId}`)
            .setLabel('Deny')
            .setEmoji('❌')
            .setStyle(ButtonStyle.Danger)
    );
}


/**
 * Create success embed after verification
 */
export function createSuccessEmbed(
    guildName: string,
    ign: string,
    roleApplied: boolean,
    nicknameSet: boolean,
    errors: string[]
): EmbedBuilder {
    const embed = new EmbedBuilder()
        .setTitle('✅ Verified!')
        .setColor(0x00FF00)
        .setDescription(
            `You're now verified in **${guildName}**.\n\n` +
            `**IGN:** ${ign}\n\n` +
            `${roleApplied ? '✅' : '❌'} Verified Raider role\n` +
            `${nicknameSet ? '✅' : '❌'} Nickname set\n\n` +
            (errors.length > 0
                ? '⚠️ **Partial success:**\n' + errors.map(e => `• ${e}`).join('\n') + '\n\n'
                : '') +
            'You can now join raids!'
        )
        .setFooter({ text: 'You can close this DM' });

    return embed;
}

// ===== VERIFICATION LOGGING =====

/**
 * Log a verification event to the veri_log channel in a dedicated thread
 * Creates a NEW thread for each verification session (identified by session start)
 */
export async function logVerificationEvent(
    guild: Guild,
    userId: string,
    message: string,
    options?: {
        embed?: EmbedBuilder;
        error?: boolean;
        sessionThreadId?: string; // Store thread ID in session to reuse for same attempt
    }
): Promise<void> {
    try {
        // Get veri_log channel
        const { channels } = await getGuildChannels(guild.id);
        const veriLogChannelId = channels.veri_log;

        if (!veriLogChannelId) {
            return; // No veri_log channel configured
        }

        const veriLogChannel = await guild.channels.fetch(veriLogChannelId);
        if (!veriLogChannel || !veriLogChannel.isTextBased()) {
            return;
        }

        // Get user info for thread name
        const user = await guild.client.users.fetch(userId);
        
        const isSessionStart = message.toLowerCase().includes('verification started');
        
        let thread;

        if (isSessionStart) {
            // NEW SESSION - Create a brand new thread with timestamp
            const timestamp = Math.floor(Date.now() / 1000);
            const threadName = `Verification - ${user.tag} - <t:${timestamp}:t>`;
            
            console.log(`[VerificationLog] Creating NEW thread for session: "${threadName}"`);

            if ('threads' in veriLogChannel) {
                thread = await veriLogChannel.threads.create({
                    name: threadName,
                    autoArchiveDuration: 60, // 1 hour
                    reason: `Verification tracking for ${user.tag}`,
                });

                // Send initial session start message
                const initialEmbed = new EmbedBuilder()
                    .setTitle('🎮 Verification Session Started')
                    .setDescription(
                        `**User:** <@${userId}> (${user.tag})\n` +
                        `**User ID:** ${userId}\n` +
                        `**Started:** <t:${timestamp}:F>`
                    )
                    .setColor(0x00AE86)
                    .setTimestamp();

                await thread.send({ embeds: [initialEmbed] });
            }
        } else {
            // EXISTING SESSION - Try to find the most recent thread for this user
            const threadNamePrefix = `Verification - ${user.tag}`;
            
            console.log(`[VerificationLog] Looking for recent thread starting with: "${threadNamePrefix}"`);

            if ('threads' in veriLogChannel) {
                const activeThreads = await veriLogChannel.threads.fetchActive();
                // Find most recent thread by sorting by creation time
                const userThreads = activeThreads.threads.filter(t => t.name.startsWith(threadNamePrefix));
                thread = userThreads.sort((a, b) => (b.createdTimestamp || 0) - (a.createdTimestamp || 0)).first();

                console.log(`[VerificationLog] Found in active threads: ${!!thread}`);

                // If not in active, check archived
                if (!thread) {
                    const archivedThreads = await veriLogChannel.threads.fetchArchived();
                    const archivedUserThreads = archivedThreads.threads.filter(t => t.name.startsWith(threadNamePrefix));
                    thread = archivedUserThreads.sort((a, b) => (b.createdTimestamp || 0) - (a.createdTimestamp || 0)).first();
                    
                    console.log(`[VerificationLog] Found in archived threads: ${!!thread}`);
                    
                    // Unarchive if found
                    if (thread && thread.archived) {
                        console.log(`[VerificationLog] Unarchiving thread`);
                        await thread.setArchived(false);
                    }
                }
            }

            // If we still can't find a thread, create one (shouldn't happen in normal flow)
            if (!thread && 'threads' in veriLogChannel) {
                console.warn(`[VerificationLog] No existing thread found for ongoing session, creating new one`);
                const timestamp = Math.floor(Date.now() / 1000);
                const threadName = `Verification - ${user.tag} - <t:${timestamp}:t>`;
                thread = await veriLogChannel.threads.create({
                    name: threadName,
                    autoArchiveDuration: 60,
                    reason: `Verification tracking for ${user.tag}`,
                });
            }
        }

        console.log(`[VerificationLog] Using thread: ${thread?.name || 'none'}, ID: ${thread?.id || 'none'}`);

        // Send the log message to the thread
        if (thread) {
            const emoji = options?.error ? '❌' : '📝';
            const color = options?.error ? 0xFF0000 : 0x5865F2;
            
            const logEmbed = new EmbedBuilder()
                .setDescription(`${emoji} ${message}`)
                .setColor(color)
                .setTimestamp();

            const messageOptions: any = { embeds: [logEmbed] };
            
            // Add custom embed if provided
            if (options?.embed) {
                messageOptions.embeds.push(options.embed);
            }

            await thread.send(messageOptions);
        }
    } catch (err) {
        // Don't fail the verification process if logging fails
        console.error('[VerificationLogging] Failed to log event:', err);
    }
}
