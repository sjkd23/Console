import { ButtonInteraction, ChannelType } from 'discord.js';
import { setKeyWindow, getRunDetails, BackendError, getRolePositions } from '../../../lib/utilities/http.js';
import { getDungeonEnteredEmoji } from '../../../lib/utilities/key-emoji-helpers.js';
import { logKeyWindow } from '../../../lib/logging/raid-logger.js';
import { sendKeyPoppedPing } from '../../../lib/utilities/run-ping.js';
import { getDefaultKeyWindowSeconds } from '../../../config/raid-config.js';
import { updateQuotaPanelsForUser } from '../../../lib/ui/quota-panel.js';
import { createLogger } from '../../../lib/logging/logger.js';
import { refreshOrganizerPanel } from './organizer-panel.js';
import { getMemberRoleIds } from '../../../lib/permissions/permissions.js';
import { transitionRunEmbed } from '../../../lib/utilities/run-panel-builder.js';

const logger = createLogger('KeyWindow');

/**
 * Handle the "Dungeon Entered" button press.
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
        const run = await getRunDetails(runId, guildId);

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

        const updatedEmbed = transitionRunEmbed(embeds[0], 'live', {
            ...run,
            keyWindowEndsAt: String(key_window_ends_at),
        });

        await pubMsg.edit({ embeds: [updatedEmbed, ...embeds.slice(1)] });

        // Send the dungeon-entered join-window ping message.
        if (btn.guild) {
            await sendKeyPoppedPing(btn.client, parseInt(runId), btn.guild, key_window_ends_at);
        }

        const enteredEmoji = getDungeonEnteredEmoji(run.runKind, run.dungeonKey);
        const displayLabel = run.selectedDungeons.map(dungeon => dungeon.dungeonLabel).join(' | ');

        // Log key window activation to raid-log
        if (btn.guild) {
            try {
                await logKeyWindow(
                    btn.client,
                    {
                        guildId: btn.guild.id,
                        organizerId: run.organizerId,
                        organizerUsername: '',
                        dungeonName: displayLabel,
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

        // Phase D retains the existing per-entry quota behavior.
        logger.debug('Triggering quota panel update for organizer after dungeon entry', {
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
            logger.debug('Successfully updated quota panel after dungeon entry', {
                runId,
                guildId,
                organizerId: run.organizerId,
                keyPopCount: run.keyPopCount
            });
        }).catch(err => {
            logger.error('Failed to auto-update quota panel after dungeon entry', {
                runId,
                guildId,
                organizerId: run.organizerId,
                error: err instanceof Error ? err.message : String(err)
            });
        });

        // Refresh organizer panel with confirmation message
        await refreshOrganizerPanel(btn, runId, `${enteredEmoji} **Dungeon entered!** Party join window started.`);

    } catch (err) {
        if (err instanceof BackendError) {
            if (err.code === 'NOT_ORGANIZER') {
                await refreshOrganizerPanel(btn, runId, '❌ Only the organizer can record a dungeon entry.');
                return;
            }
            if (err.code === 'RUN_NOT_LIVE') {
                await refreshOrganizerPanel(btn, runId, '❌ You can only record a dungeon entry during Live.');
                return;
            }
        }
        const msg = err instanceof Error ? err.message : 'Unknown error';
        await btn.editReply({ content: `Error: ${msg}`, embeds: [], components: [] });
    }
}
