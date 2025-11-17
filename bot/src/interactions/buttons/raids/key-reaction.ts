import { ButtonInteraction, EmbedBuilder, MessageFlags } from 'discord.js';
import { postJSON, getJSON } from '../../../lib/utilities/http.js';
import { formatKeyLabel, getKeyTypeSuffix, getDungeonKeyEmoji } from '../../../lib/utilities/key-emoji-helpers.js';
import { logKeyReaction } from '../../../lib/logging/raid-logger.js';


function updateKeysField(embed: EmbedBuilder, keyCounts: Record<string, number>, dungeonKey: string, btn: ButtonInteraction): EmbedBuilder {
    const data = embed.toJSON();
    let fields = [...(data.fields ?? [])];

    // Get the dungeon-specific key emoji
    const dungeonKeyEmoji = getDungeonKeyEmoji(dungeonKey);

    // Filter out zero-count keys and format with emojis
    const entries = Object.entries(keyCounts)
        .filter(([, count]) => count > 0)
        .map(([keyType, count]) => {
            const label = formatKeyLabel(keyType);
            // Use the dungeon-specific emoji for all keys
            return `${dungeonKeyEmoji} ${label}: **${count}**`;
        });



    let keysText: string;
    if (entries.length === 0) {
        keysText = 'No keys reported';
    } else {
        keysText = entries.join(' • ');
    }

    const idx = fields.findIndex(f => (f.name ?? '').toLowerCase() === 'keys');
    if (idx >= 0) {
        fields[idx] = { ...fields[idx], value: keysText };
    } else {
        // Insert after Raiders field or at the end
        const raidersIdx = fields.findIndex(f => (f.name ?? '').toLowerCase() === 'raiders');
        if (raidersIdx >= 0) {
            fields.splice(raidersIdx + 1, 0, { name: 'Keys', value: keysText, inline: false });
        } else {
            fields.push({ name: 'Keys', value: keysText, inline: false });
        }
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
    const run = await getJSON<{ 
        dungeonKey: string; 
        dungeonLabel: string;
        organizerId: string;
    }>(`/runs/${runId}`, { guildId }).catch(() => null);
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

    // Log to raid-log thread
    if (btn.guild) {
        try {
            await logKeyReaction(
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

    // Get the dungeon-specific emoji
    const dungeonKeyEmoji = getDungeonKeyEmoji(run.dungeonKey);

    if (result.keyCounts[keyType]) {
        // User added their key
        await btn.editReply({
            content: `${dungeonKeyEmoji} You've reacted with a **${keyLabel} ${keyTypeSuffix}**.\n\nIf this was a mistake, please click the button again to unreact!`
        });
    } else {
        // User removed their key
        await btn.editReply({
            content: `${dungeonKeyEmoji} You've removed your **${keyLabel} ${keyTypeSuffix}** reaction.`
        });
    }
}
