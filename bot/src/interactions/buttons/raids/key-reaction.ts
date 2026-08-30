import { ButtonInteraction, EmbedBuilder, MessageFlags } from 'discord.js';
import { postJSON, getRunDetails, getRunDisplayLabel } from '../../../lib/utilities/http.js';
import { formatKeyLabel, getKeyTypeSuffix, getDungeonKeyEmoji, getEmojiDisplayForKeyType } from '../../../lib/utilities/key-emoji-helpers.js';
import { logKeyReaction } from '../../../lib/logging/raid-logger.js';
import { getAllOrganizerPanelsForRun } from '../../../lib/state/organizer-panel-tracker.js';
import { updateRunOrganizerPanel } from './organizer-panel.js';
import { sendKeyReactorDM, hasBeenNotified, markAsNotified } from '../../../lib/utilities/key-reactor-notifications.js';


function updateKeysField(embed: EmbedBuilder, keyCounts: Record<string, number>, dungeonKey: string, btn: ButtonInteraction): EmbedBuilder {
    const data = embed.toJSON();
    let fields = [...(data.fields ?? [])];

    // Filter out zero-count keys and format with emojis
    const entries = Object.entries(keyCounts)
        .filter(([, count]) => count > 0)
        .map(([keyType, count]) => {
            const label = formatKeyLabel(keyType);
            // Use the key-specific emoji for each key type
            const keyEmoji = getEmojiDisplayForKeyType(keyType);
            return `${keyEmoji} ${label}: **${count}**`;
        });



    let keysText: string;
    if (entries.length === 0) {
        keysText = 'None';
    } else {
        keysText = entries.join(' • ');
    }

    const idx = fields.findIndex(f => (f.name ?? '').toLowerCase() === 'keys');
    if (idx >= 0) {
        fields[idx] = { ...fields[idx], value: keysText };
    } else {
        // Insert at the beginning of the field list
        fields.unshift({ name: 'Keys', value: keysText, inline: false });
    }

    return new EmbedBuilder(data).setFields(fields as any);
}

export async function handleKeyReaction(btn: ButtonInteraction, runId: string, keyType: string) {
    // Defer the reply so we can send a follow-up message
    await btn.deferReply({ flags: MessageFlags.Ephemeral });

    const guildId = btn.guildId;
    if (!guildId) {
        await btn.editReply({ content: 'This command can only be used in a server.' });
        return;
    }

    // Fetch run details to get dungeonKey and organizerId
    const run = await getRunDetails(runId, guildId).catch(() => null);
    if (!run) {
        await btn.editReply({ content: 'Could not fetch run details.' });
        return;
    }

    // Toggle the key reaction
    const result = await postJSON<{ keyCounts: Record<string, number>; added: boolean }>(
        `/runs/${runId}/key-reactions`,
        {
            userId: btn.user.id,
            keyType: keyType
        },
        { guildId }
    );

    const msg = btn.message;
    const embeds = msg.embeds ?? [];
    if (!embeds.length) return;

    const first = EmbedBuilder.from(embeds[0]);
    const updatedWithKeys = updateKeysField(first, result.keyCounts, run.dungeonKey, btn);

    await msg.edit({ embeds: [updatedWithKeys, ...embeds.slice(1)] });

    // Auto-refresh any active organizer panels for this run
    const activePanels = getAllOrganizerPanelsForRun(runId);
    for (const { handle } of activePanels) {
        try {
            // Update the panel using the handle (knows how to edit itself correctly)
            await updateRunOrganizerPanel(handle, parseInt(runId), guildId);
        } catch (err) {
            // Silently fail - organizer panel might be closed or expired
            console.log('Failed to auto-refresh organizer panel:', err);
        }
    }

    // Log to raid-log thread
    if (btn.guild) {
        try {
            await logKeyReaction(
                btn.client,
                {
                    guildId: btn.guild.id,
                    organizerId: run.organizerId,
                    organizerUsername: '',
                    dungeonName: getRunDisplayLabel(run),
                    type: 'run',
                    runId: parseInt(runId)
                },
                btn.user.id,
                keyType,
                result.added ? 'added' : 'removed',
                result.keyCounts[keyType] || 0
            );
        } catch (e) {
            console.error('Failed to log key reaction to raid-log:', e);
        }
    }

    // Send ephemeral confirmation message with proper key type
    const keyTypeSuffix = getKeyTypeSuffix(keyType);
    const keyLabel = formatKeyLabel(keyType);

    // Get the key-specific emoji
    const keyEmoji = getEmojiDisplayForKeyType(keyType);

    // Check if party and location are both set
    const hasPartyAndLocation = !!(run.party && run.location);

    if (result.keyCounts[keyType]) {
        // User added their key
        let confirmMessage = `${keyEmoji} **${keyLabel} ${keyTypeSuffix} added!** Click again to remove.`;
        
        if (hasPartyAndLocation) {
            // Party and location are already set
            // Check if we've already sent this party/location to this user
            const alreadyNotified = hasBeenNotified(runId, btn.user.id, run.party!, run.location!);
            
            if (!alreadyNotified) {
                // Send DM for the first time
                const dmSent = await sendKeyReactorDM(
                    btn.client,
                    btn.user.id,
                    guildId,
                    runId,
                    getRunDisplayLabel(run),
                    run.organizerId,
                    [keyType],
                    run.party!,
                    run.location!,
                    false
                );
                
                if (dmSent) {
                    markAsNotified(runId, btn.user.id, run.party!, run.location!);
                    confirmMessage += `\n\n✉️ You have been sent a DM with the party and location.\n\n**Party:** ${run.party} | **Location:** ${run.location}`;
                } else {
                    confirmMessage += '\n\n⚠️ Could not send you a DM. Please check your privacy settings.';
                    confirmMessage += `\n\n**Party:** ${run.party} | **Location:** ${run.location}`;
                    confirmMessage += `\nPlease join the party and go to the location as soon as possible to confirm your ${keyLabel.toLowerCase()} with the organizer.`;
                }
            } else {
                // Already sent DM for this party/location - don't spam, but still show info
                confirmMessage += `\n\n✅ You have already been sent the party and location details via DM.\n\n**Party:** ${run.party} | **Location:** ${run.location}`;
            }
        } else {
            // Party/location not set yet - notify they'll be DM'd later
            confirmMessage += '\n\n📬 You will receive a DM when the organizer sets the party and location. Please come to the location as soon as possible to confirm your key/rune with the organizer.';
        }
        
        await btn.editReply({ content: confirmMessage });
    } else {
        // User removed their key
        await btn.editReply({
            content: `${keyEmoji} **${keyLabel} ${keyTypeSuffix} removed.**`
        });
    }
}
