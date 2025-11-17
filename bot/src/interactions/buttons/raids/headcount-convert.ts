/**
 * Handles converting a headcount panel to a run panel.
 * Allows the organizer to select which dungeon to convert, preserving key reactions.
 */

import {
    ButtonInteraction,
    EmbedBuilder,
    StringSelectMenuBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    MessageFlags,
    ChannelType,
    type GuildTextBasedChannel
} from 'discord.js';
import { getOrganizerId, getParticipants } from '../../../lib/state/headcount-state.js';
import { getKeyOffers, clearKeyOffers } from './headcount-key.js';
import { dungeonByCode } from '../../../constants/dungeons/dungeon-helpers.js';
import { postJSON } from '../../../lib/utilities/http.js';
import { getMemberRoleIds } from '../../../lib/permissions/permissions.js';
import { getReactionInfo } from '../../../constants/emojis/MappedAfkCheckReactions.js';
import { formatKeyLabel, getDungeonKeyEmoji, getDungeonKeyEmojiIdentifier } from '../../../lib/utilities/key-emoji-helpers.js';
import { fetchGuildMember } from '../../../lib/utilities/interaction-helpers.js';
import { logRaidCreation } from '../../../lib/logging/raid-logger.js';
import { checkOrganizerAccess } from '../../../lib/permissions/interaction-permissions.js';
import { withButtonLock, getHeadcountLockKey } from '../../../lib/utilities/button-mutex.js';
import { getDefaultAutoEndMinutes } from '../../../config/raid-config.js';

export async function handleHeadcountConvert(btn: ButtonInteraction, publicMessageId: string) {
    // CRITICAL: Wrap in mutex to prevent concurrent conversion
    const executed = await withButtonLock(btn, getHeadcountLockKey('convert', publicMessageId), async () => {
        await handleHeadcountConvertInternal(btn, publicMessageId);
    });

    if (!executed) {
        // Lock was not acquired, user was already notified
        return;
    }
}

/**
 * Internal handler for headcount conversion (protected by mutex).
 */
async function handleHeadcountConvertInternal(btn: ButtonInteraction, publicMessageId: string) {
    // Fetch the public headcount message
    if (!btn.channel || btn.channel.type !== ChannelType.GuildText) {
        await btn.reply({
            content: 'Could not locate headcount channel.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    const publicMsg = await btn.channel.messages.fetch(publicMessageId).catch(() => null);
    if (!publicMsg) {
        await btn.reply({
            content: 'Could not find headcount panel message.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    const embeds = publicMsg.embeds ?? [];
    if (!embeds.length) {
        await btn.reply({
            content: 'Could not find headcount panel.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    const embed = EmbedBuilder.from(embeds[0]);
    const organizerId = getOrganizerId(embed);

    if (!organizerId) {
        await btn.reply({
            content: 'Could not determine the headcount organizer.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    // Authorization check using centralized helper
    const accessCheck = await checkOrganizerAccess(btn, organizerId);
    if (!accessCheck.allowed) {
        await btn.reply({
            content: accessCheck.errorMessage,
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    // Extract dungeon codes from the button components
    const dungeonCodes: string[] = [];
    for (const row of publicMsg.components) {
        if ('components' in row) {
            for (const component of row.components) {
                if ('customId' in component && component.customId?.startsWith('headcount:key:')) {
                    const parts = component.customId.split(':');
                    const dungeonCode = parts[3];
                    if (dungeonCode && !dungeonCodes.includes(dungeonCode)) {
                        dungeonCodes.push(dungeonCode);
                    }
                }
            }
        }
    }

    if (dungeonCodes.length === 0) {
        await btn.reply({
            content: '❌ No dungeons found on this headcount panel.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    // If only one dungeon, no need for dropdown - just convert it
    if (dungeonCodes.length === 1) {
        await btn.deferUpdate(); // Update the organizer panel message
        await convertHeadcountToRun(btn, publicMsg, dungeonCodes[0], btn.user.id);
        return;
    }

    // Multiple dungeons - show dropdown to select which one to convert
    // First, update the organizer panel to remove buttons (prevent double-clicks)
    await btn.update({
        components: [] // Remove End/Convert buttons
    });

    // Now show the dropdown as a follow-up
    const followUpMsg = await btn.followUp({
        content: '**Select a dungeon to convert to a run**\n\nKey reactions for the selected dungeon will be preserved.',
        components: [createDungeonSelectMenu(dungeonCodes)],
        flags: MessageFlags.Ephemeral
    });

    // Wait for selection
    try {
        const selectInteraction = await btn.channel!.awaitMessageComponent({
            filter: (i) => i.user.id === btn.user.id && i.customId === 'headcount:select_convert_dungeon',
            componentType: ComponentType.StringSelect,
            time: 60_000 // 60 second timeout
        });

        await selectInteraction.deferUpdate();

        const selectedCode = selectInteraction.values[0];
        
        // Update the dropdown to show confirmation
        await selectInteraction.editReply({
            content: `✅ **Converting to run...**`,
            components: []
        });

        // Convert the headcount to a run
        await convertHeadcountToRun(selectInteraction, publicMsg, selectedCode, btn.user.id);

    } catch (err) {
        // Timeout or other error
        const errorMessage = err instanceof Error 
            ? `Failed to convert headcount: ${err.message}`
            : 'Selection timed out. Please try again.';
        
        await followUpMsg.edit({
            content: errorMessage,
            components: []
        });
    }
}

/**
 * Helper to create the dungeon selection dropdown
 */
function createDungeonSelectMenu(dungeonCodes: string[]): ActionRowBuilder<StringSelectMenuBuilder> {
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('headcount:select_convert_dungeon')
        .setPlaceholder('Select a dungeon to convert to a run')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(
            dungeonCodes.map(code => {
                const dungeon = dungeonByCode[code];
                return {
                    label: dungeon?.dungeonName || code,
                    value: code,
                    description: dungeon?.dungeonCategory || undefined
                };
            })
        );

    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
}

/**
 * Converts a headcount to a run with the selected dungeon
 */
async function convertHeadcountToRun(
    interaction: ButtonInteraction | any, // StringSelectMenuInteraction
    publicMsg: any,
    dungeonCode: string,
    organizerId: string
) {
    const dungeon = dungeonByCode[dungeonCode];

    if (!dungeon) {
        await interaction.followUp({
            content: 'Unknown dungeon selected. Please try again.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    // Get guild and member for role IDs
    if (!interaction.guild) {
        await interaction.followUp({
            content: 'This command can only be used in a server.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    const member = await fetchGuildMember(interaction.guild, organizerId);
    if (!member) {
        await interaction.followUp({
            content: 'Could not fetch your member information.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    // Get key offers for the selected dungeon
    const keyOffers = getKeyOffers(publicMsg.id);
    const dungeonKeys = keyOffers.get(dungeonCode);
    const keyUserIds = dungeonKeys ? Array.from(dungeonKeys) : [];
    const guildId = interaction.guildId!;

    // Create the run in the backend (use the channel where the headcount was posted)
    const { runId } = await postJSON<{ runId: number }>('/runs', {
        guildId: interaction.guild.id,
        guildName: interaction.guild.name,
        organizerId: organizerId,
        organizerUsername: interaction.user.username,
        organizerRoles: getMemberRoleIds(member),
        channelId: publicMsg.channelId, // Use the channel where headcount was posted (should be raid channel)
        dungeonKey: dungeon.codeName,
        dungeonLabel: dungeon.dungeonName,
        autoEndMinutes: getDefaultAutoEndMinutes()
    }, { guildId });

    // If there are key reactions, register them with the backend
    if (keyUserIds.length > 0 && dungeon.keyReactions && dungeon.keyReactions.length > 0) {
        // Use the first key type from the dungeon's key reactions
        const keyType = dungeon.keyReactions[0].mapKey;
        
        for (const userId of keyUserIds) {
            try {
                await postJSON(`/runs/${runId}/key-reactions`, {
                    userId,
                    keyType
                }, { guildId });
            } catch (err) {
                console.error(`Failed to register key reaction for user ${userId}:`, err);
            }
        }
    }

    // Build the run embed
    const runEmbed = new EmbedBuilder()
        .setTitle(`⏳ Starting Soon: ${dungeon.dungeonName}`)
        .setDescription(`Organizer: <@${organizerId}>`)
        .addFields(
            { name: 'Raiders', value: '0', inline: false }
        )
        .setTimestamp(new Date());

    // Add Keys field if the dungeon has key reactions
    if (dungeon.keyReactions && dungeon.keyReactions.length > 0) {
        // Format keys field to match run panel style (count only, no user mentions)
        if (keyUserIds.length > 0) {
            // Get the dungeon-specific key emoji
            const dungeonKeyEmoji = getDungeonKeyEmoji(dungeon.codeName);
            const keyLabel = formatKeyLabel(dungeon.keyReactions[0].mapKey);
            const keysText = `${dungeonKeyEmoji} ${keyLabel}: **${keyUserIds.length}**`;
            runEmbed.addFields({ name: 'Keys', value: keysText, inline: false });
        } else {
            runEmbed.addFields({ name: 'Keys', value: 'None', inline: false });
        }
    }

    // Color & thumbnail
    if (dungeon.dungeonColors?.length) runEmbed.setColor(dungeon.dungeonColors[0]);
    if (dungeon.portalLink?.url) runEmbed.setThumbnail(dungeon.portalLink.url);

    // Public buttons + organizer panel opener
    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`run:join:${runId}`)
            .setLabel('Join')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`run:leave:${runId}`)
            .setLabel('Leave')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`run:org:${runId}`)
            .setLabel('Organizer Panel')
            .setStyle(ButtonStyle.Secondary)
    );

    // Key buttons based on dungeon type
    const keyRows: ActionRowBuilder<ButtonBuilder>[] = [];
    if (dungeon.keyReactions && dungeon.keyReactions.length > 0) {
        const keyButtons: ButtonBuilder[] = [];
        for (const keyReaction of dungeon.keyReactions) {
            const reactionInfo = getReactionInfo(keyReaction.mapKey);
            const button = new ButtonBuilder()
                .setCustomId(`run:key:${runId}:${keyReaction.mapKey}`)
                .setLabel(formatKeyLabel(keyReaction.mapKey))
                .setStyle(ButtonStyle.Secondary);
            
            // Add emoji if available
            if (reactionInfo?.emojiInfo?.identifier) {
                button.setEmoji(reactionInfo.emojiInfo.identifier);
            }
            
            keyButtons.push(button);
        }

        // Split into rows of up to 5 buttons
        for (let i = 0; i < keyButtons.length; i += 5) {
            const rowButtons = keyButtons.slice(i, i + 5);
            keyRows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...rowButtons));
        }
    }

    // Update the headcount message to become the run message
    await publicMsg.edit({
        content: '@here',
        embeds: [runEmbed],
        components: [row1, ...keyRows]
    });

    // Store the message ID in the backend
    try {
        await postJSON(`/runs/${runId}/message`, { postMessageId: publicMsg.id }, { guildId });
    } catch (e) {
        console.error('Failed to store post_message_id:', e);
    }

    // Log the run creation to raid-log channel (converted from headcount)
    try {
        await logRaidCreation(
            interaction.client,
            {
                guildId: interaction.guild.id,
                organizerId: organizerId,
                organizerUsername: interaction.user.username,
                dungeonName: dungeon.dungeonName,
                type: 'run',
                runId: runId
            },
            {
                description: 'Converted from headcount panel'
            }
        );
    } catch (e) {
        console.error('Failed to log converted run creation to raid-log:', e);
    }

    // Clear headcount state from memory
    clearKeyOffers(publicMsg.id);

    // Send a NEW run organizer panel
    const runOrgPanelEmbed = new EmbedBuilder()
        .setTitle(`Organizer Panel — ${dungeon.dungeonName}`)
        .setTimestamp(new Date());

    // Build description with key reaction users if any
    let description = '✅ **Converted from headcount to run**\n\nUse the controls below to manage the raid.';

    if (keyUserIds.length > 0) {
        description += '\n\n**Key Reacts:**';
        
        // Get the dungeon-specific key emoji
        const dungeonKeyEmoji = getDungeonKeyEmoji(dungeon.codeName);
        const keyLabel = formatKeyLabel(dungeon.keyReactions![0].mapKey);
        
        // Create user mentions
        const mentions = keyUserIds.map(id => `<@${id}>`).join(', ');
        description += `\n${dungeonKeyEmoji} **${keyLabel}** (${keyUserIds.length}): ${mentions}`;
    }

    runOrgPanelEmbed.setDescription(description);

    // Starting phase: Start, Cancel (row 1) + Set Party, Set Location (row 2)
    const orgRow1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`run:start:${runId}`)
            .setLabel('Start')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`run:cancel:${runId}`)
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Danger)
    );
    const orgRow2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`run:setparty:${runId}`)
            .setLabel('Set Party')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`run:setlocation:${runId}`)
            .setLabel('Set Location')
            .setStyle(ButtonStyle.Secondary)
    );

    // Send the new run organizer panel as a follow-up
    await interaction.followUp({
        embeds: [runOrgPanelEmbed],
        components: [orgRow1, orgRow2],
        flags: MessageFlags.Ephemeral
    });
}
