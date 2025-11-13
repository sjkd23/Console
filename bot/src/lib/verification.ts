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
import { postJSON, getJSON, patchJSON, verifyRaider, BackendError } from './http.js';
import { getGuildChannels } from './http.js';
import crypto from 'crypto';

// ===== TYPES =====

export type VerificationStatus = 
    | 'pending_ign' 
    | 'pending_realmeye' 
    | 'verified' 
    | 'cancelled' 
    | 'expired';

export interface VerificationSession {
    guild_id: string;
    user_id: string;
    rotmg_ign: string | null;
    verification_code: string | null;
    status: VerificationStatus;
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
    const { fetchRealmEyePlayerProfile } = await import('../services/realmeye/index.js');
    
    const profile = await fetchRealmEyePlayerProfile(ign);

    // Map result codes to the existing return format for backward compatibility
    switch (profile.resultCode) {
        case 'Success': {
            // Join description lines into a single string for the legacy format
            const description = profile.descriptionLines.join('\n');
            const found = description.includes(code);

            if (found) {
                console.log('[Verification] ✅ Code found in description!');
            } else {
                console.log('[Verification] ❌ Code NOT found in description');
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
    actorUserId: string
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
            await verifyRaider({
                actor_user_id: actorUserId,
                guild_id: guild.id,
                user_id: member.id,
                ign,
            });
        } catch (backendErr) {
            console.error('[Verification] Failed to record verification in backend:', backendErr);
            // Don't add to user-facing errors since Discord changes succeeded
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
export function createVerificationPanelEmbed(): EmbedBuilder {
    return new EmbedBuilder()
        .setTitle('🎯 Get Verified')
        .setDescription(
            '**Welcome to the verification process!**\n\n' +
            'To participate in raids and access full server features, you need to verify your ROTMG account.\n\n' +
            '**How it works:**\n' +
            '1️⃣ Click the **"Get Verified"** button below\n' +
            '2️⃣ Follow the instructions sent to your DMs\n' +
            '3️⃣ You\'ll need to add a code to your RealmEye profile description\n' +
            '4️⃣ Once verified, you\'ll receive the Verified Raider role!\n\n' +
            '**Requirements:**\n' +
            '• A public RealmEye profile\n' +
            '• DMs enabled for this server\n\n' +
            '**Ready?** Click the button below to start!'
        )
        .setColor(0x00AE86)
        .setFooter({ text: 'Need help? Contact a staff member' });
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
            '**Step 1: Provide your ROTMG IGN**\n\n' +
            'Please reply with your **in-game name** (IGN) from Realm of the Mad God.\n\n' +
            '**Important:**\n' +
            '• This must match your RealmEye profile name exactly\n' +
            '• Your profile must be **public** on RealmEye\n' +
            '• Type your IGN in the next message'
        )
        .setColor(0x00AE86)
        .setFooter({ text: 'You can cancel anytime by typing "cancel"' });
}

/**
 * Create DM embed for RealmEye code instructions
 */
export function createRealmEyeInstructionsEmbed(
    ign: string,
    code: string,
    guildName: string
): EmbedBuilder {
    return new EmbedBuilder()
        .setTitle('📝 Add Code to RealmEye')
        .setDescription(
            `**Server:** ${guildName}\n` +
            `**IGN:** ${ign}\n\n` +
            '**Step 2: Add verification code to RealmEye**\n\n' +
            'Go to your RealmEye profile and add this code to your **description**:\n\n' +
            `\`\`\`\n${code}\n\`\`\`\n\n` +
            '**Instructions:**\n' +
            `1. Go to https://www.realmeye.com/player/${encodeURIComponent(ign)}\n` +
            '2. Make sure you\'re logged in\n' +
            '3. Edit your profile description\n' +
            '4. Paste the code above somewhere in your description\n' +
            '5. Save your profile\n' +
            '6. Click **Done** below when ready\n\n' +
            '**Note:** The code must be in your **description**, not your name or guild.'
        )
        .setColor(0x00AE86)
        .setFooter({ text: 'This code expires in 1 hour' });
}

/**
 * Create buttons for RealmEye verification step
 */
export function createRealmEyeButtons(): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId('verification:done')
            .setLabel('Done')
            .setEmoji('✅')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId('verification:cancel')
            .setLabel('Cancel')
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
        .setTitle('✅ Verification Complete!')
        .setColor(0x00FF00)
        .setDescription(
            `**Congratulations!** You've been verified in **${guildName}**.\n\n` +
            `**IGN:** ${ign}\n\n` +
            '**What happened:**\n' +
            `${roleApplied ? '✅' : '❌'} Verified Raider role assigned\n` +
            `${nicknameSet ? '✅' : '❌'} Nickname set to your IGN\n\n` +
            (errors.length > 0
                ? '⚠️ **Partial Success:**\n' + errors.map(e => `• ${e}`).join('\n') + '\n\n'
                : '') +
            'You can now participate in raids! See you in the realm!'
        )
        .setFooter({ text: 'You can now close this DM' });

    return embed;
}
