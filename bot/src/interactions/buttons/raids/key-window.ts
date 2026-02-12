import { ButtonInteraction, ChannelType, EmbedBuilder } from 'discord.js';
import { setKeyWindow, getJSON, BackendError, getRolePositions } from '../../../lib/utilities/http.js';
import { getDungeonKeyEmoji } from '../../../lib/utilities/key-emoji-helpers.js';
import { logKeyWindow } from '../../../lib/logging/raid-logger.js';
import { sendKeyPoppedPing } from '../../../lib/utilities/run-ping.js';
import { getDefaultKeyWindowSeconds } from '../../../config/raid-config.js';
import { updateQuotaPanelsForUser } from '../../../lib/ui/quota-panel.js';
import { createLogger } from '../../../lib/logging/logger.js';
import { refreshOrganizerPanel } from './organizer-panel.js';
import { getMemberRoleIds } from '../../../lib/permissions/permissions.js';

const logger = createLogger('KeyWindow');

/**
 * Handle "Key popped" button press.
 * Sets a configurable party join window and updates the run embed.
 */
export async function handleKeyWindow(btn: ButtonInteraction, runId: string) {
    await btn.deferUpdate();

    const guildId = btn.guildId;
    if (!guildId) {
        await btn.editReply({ content: 'This command can only be used in a server.', components: [] });
        return;
    }

    const keyWindowSeconds = getDefaultKeyWindowSeconds();

    const member = btn.guild ? await btn.guild.members.fetch(btn.user.id).catch(() => null) : null;

    try {
        // Call backend to set the key window
        const { key_window_ends_at } = await setKeyWindow(Number(runId), {
            actor_user_id: btn.user.id,
            actor_roles: getMemberRoleIds(member),
            actor_role_positions: member ? getRolePositions(member) : undefined,
            seconds: keyWindowSeconds,
        }, guildId);

        // Fetch full run details to rebuild embed
        const run = await getJSON<{
            channelId: string | null;
            postMessageId: string | null;
            status: string;
            dungeonKey: string;
            dungeonLabel: string;
            organizerId: string;
            startedAt: string | null;
            keyWindowEndsAt: string | null;
            party: string | null;
            location: string | null;
            description: string | null;
            keyPopCount: number;
            chainAmount: number | null;
        }>(`/runs/${runId}`, { guildId });

        if (!run.channelId || !run.postMessageId) {
            await btn.editReply({ content: 'Run record missing channel/message id.', components: [] });
            return;
        }

        const ch = await btn.client.channels.fetch(run.channelId).catch(() => null);
        if (!ch || ch.type !== ChannelType.GuildText) {
            await btn.editReply({ content: 'Could not locate run channel.', components: [] });
            return;
        }

        const pubMsg = await ch.messages.fetch(run.postMessageId).catch(() => null);
        if (!pubMsg) {
            await btn.editReply({ content: 'Public run message no longer exists.', components: [] });
            return;
        }

        // Update the embed with the key window line
        const embeds = pubMsg.embeds ?? [];
        if (!embeds.length) {
            await btn.editReply({ content: 'Could not find run embed.', components: [] });
            return;
        }

        const updatedEmbed = buildLiveEmbed(embeds[0], run, key_window_ends_at, btn);

        await pubMsg.edit({ embeds: [updatedEmbed, ...embeds.slice(1)] });

        // Send key popped ping message
        if (btn.guild) {
            await sendKeyPoppedPing(btn.client, parseInt(runId), btn.guild, key_window_ends_at);
        }

        // Get the dungeon-specific key emoji
        const keyEmoji = getDungeonKeyEmoji(run.dungeonKey);

        // Log key window activation to raid-log
        if (btn.guild) {
            try {
                await logKeyWindow(
                    btn.client,
                    {
                        guildId: btn.guild.id,
                        organizerId: run.organizerId,
                        organizerUsername: '',
                        dungeonName: run.dungeonLabel,
                        type: 'run',
                        runId: parseInt(runId)
                    },
                    btn.user.id,
                    keyWindowSeconds
                );
            } catch (e) {
                console.error('Failed to log key window to raid-log:', e);
            }
        }

        // Auto-update quota panels for the organizer after key pop
        // Key pops award organizer quota points (one per key pop)
        logger.debug('Triggering quota panel update for organizer after key pop', {
            runId,
            guildId,
            organizerId: run.organizerId,
            keyPopCount: run.keyPopCount
        });
        
        // Run asynchronously to not block the response
        updateQuotaPanelsForUser(
            btn.client,
            guildId,
            run.organizerId
        ).then(() => {
            logger.debug('Successfully updated quota panel after key pop', {
                runId,
                guildId,
                organizerId: run.organizerId,
                keyPopCount: run.keyPopCount
            });
        }).catch(err => {
            logger.error('Failed to auto-update quota panel after key pop', {
                runId,
                guildId,
                organizerId: run.organizerId,
                error: err instanceof Error ? err.message : String(err)
            });
        });

        // Refresh organizer panel with confirmation message
        await refreshOrganizerPanel(btn, runId, `${keyEmoji} **Key popped!** Party join window started.`);

    } catch (err) {
        if (err instanceof BackendError) {
            if (err.code === 'NOT_ORGANIZER') {
                await refreshOrganizerPanel(btn, runId, '❌ Only the organizer can pop keys.');
                return;
            }
            if (err.code === 'RUN_NOT_LIVE') {
                await refreshOrganizerPanel(btn, runId, '❌ You can only pop keys during Live.');
                return;
            }
        }
        const msg = err instanceof Error ? err.message : 'Unknown error';
        await btn.editReply({ content: `Error: ${msg}`, embeds: [], components: [] });
    }
}

/**
 * Build the Live phase embed with optional key window line.
 */
function buildLiveEmbed(
    original: any,
    run: {
        dungeonKey: string;
        dungeonLabel: string;
        organizerId: string;
        startedAt: string | null;
        keyWindowEndsAt: string | null;
        party: string | null;
        location: string | null;
        description: string | null;
        keyPopCount: number;
        chainAmount: number | null;
    },
    keyWindowEndsAt: string | null,
    btn: ButtonInteraction
): EmbedBuilder {
    const embed = EmbedBuilder.from(original);

    // Set title with LIVE badge and optional chain tracking (not for Oryx 3)
    let chainText = '';
    if (run.dungeonKey !== 'ORYX_3' && run.keyPopCount > 0) {
        if (run.chainAmount && run.keyPopCount <= run.chainAmount) {
            // Show Chain X/Y only if chain amount is set AND not exceeded
            chainText = ` | Chain ${run.keyPopCount}/${run.chainAmount}`;
        } else {
            // Show Chain X if no chain amount set OR if count exceeded amount
            chainText = ` | Chain ${run.keyPopCount}`;
        }
    }
    embed.setTitle(`🟢 LIVE: ${run.dungeonLabel}${chainText}`);

    // Build description with organizer and key window if active
    let desc = `Organizer: <@${run.organizerId}>`;

    // Add key window if end time is in the future
    if (keyWindowEndsAt) {
        const endsUnix = Math.floor(new Date(keyWindowEndsAt).getTime() / 1000);
        const now = Math.floor(Date.now() / 1000);

        if (endsUnix > now) {
            // Get the dungeon-specific key emoji
            const keyEmoji = getDungeonKeyEmoji(run.dungeonKey);

            desc += `\n\n${keyEmoji} **Key popped**\nParty join window closes <t:${endsUnix}:R>`;

        }
    }

    embed.setDescription(desc);

    // Keep existing fields (Raiders, Keys, etc.) but remove Party/Location and Classes
    const data = embed.toJSON();
    const fields = [...(data.fields ?? [])];

    // Remove Party field if present
    const partyIdx = fields.findIndex(f => (f.name ?? '').toLowerCase() === 'party');
    if (partyIdx >= 0) {
        fields.splice(partyIdx, 1);
    }

    // Remove Location field if present
    const locIdx = fields.findIndex(f => (f.name ?? '').toLowerCase() === 'location');
    if (locIdx >= 0) {
        fields.splice(locIdx, 1);
    }

    // Remove Classes field if present
    const classIdx = fields.findIndex(f => (f.name ?? '').toLowerCase() === 'classes');
    if (classIdx >= 0) {
        fields.splice(classIdx, 1);
    }

    // Update or add Organizer Note field
    if (run.description) {
        const noteIdx = fields.findIndex(f => (f.name ?? '').toLowerCase() === 'organizer note');
        if (noteIdx >= 0) {
            fields[noteIdx] = { ...fields[noteIdx], value: run.description };
        }
    }

    return embed.setFields(fields as any);
}
