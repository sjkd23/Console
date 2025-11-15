import { ButtonInteraction, ChannelType, EmbedBuilder } from 'discord.js';
import { setKeyWindow, getJSON, BackendError } from '../../../lib/utilities/http.js';
import { getDungeonKeyEmoji } from '../../../lib/utilities/key-emoji-helpers.js';
import { logKeyWindow } from '../../../lib/logging/raid-logger.js';
import { sendKeyPoppedPing } from '../../../lib/utilities/run-ping.js';

/**
 * Handle "Key popped" button press.
 * Sets a 30-second party join window and updates the run embed.
 */
export async function handleKeyWindow(btn: ButtonInteraction, runId: string) {
    await btn.deferUpdate();

    try {
        // Call backend to set the key window
        const { key_window_ends_at } = await setKeyWindow(Number(runId), {
            actor_user_id: btn.user.id,
            seconds: 30,
        });

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
        }>(`/runs/${runId}`);

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
                    30 // 30 seconds
                );
            } catch (e) {
                console.error('Failed to log key window to raid-log:', e);
            }
        }

        // Confirm to organizer
        await btn.editReply({ content: `${keyEmoji} Key popped! Party join window started.` });

    } catch (err) {
        if (err instanceof BackendError) {
            if (err.code === 'NOT_ORGANIZER') {
                await btn.editReply({ content: 'Only the organizer can pop keys.', components: [] });
                return;
            }
            if (err.code === 'RUN_NOT_LIVE') {
                await btn.editReply({ content: 'You can only pop keys during Live.', components: [] });
                return;
            }
        }
        const msg = err instanceof Error ? err.message : 'Unknown error';
        await btn.editReply({ content: `Error: ${msg}`, components: [] });
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
    },
    keyWindowEndsAt: string | null,
    btn: ButtonInteraction
): EmbedBuilder {
    const embed = EmbedBuilder.from(original);

    // Set title with LIVE badge
    embed.setTitle(`🟢 LIVE: ${run.dungeonLabel}`);

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

    // Keep existing fields (Raiders, Classes, etc.) but update Party/Location if needed
    const data = embed.toJSON();
    const fields = [...(data.fields ?? [])];

    // Update or add Party field
    if (run.party) {
        const partyIdx = fields.findIndex(f => (f.name ?? '').toLowerCase() === 'party');
        if (partyIdx >= 0) {
            fields[partyIdx] = { ...fields[partyIdx], value: run.party };
        }
    }

    // Update or add Location field
    if (run.location) {
        const locIdx = fields.findIndex(f => (f.name ?? '').toLowerCase() === 'location');
        if (locIdx >= 0) {
            fields[locIdx] = { ...fields[locIdx], value: run.location };
        }
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
