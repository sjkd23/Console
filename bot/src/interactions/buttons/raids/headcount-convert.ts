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
import { getOrganizerId, getParticipants, clearParticipants } from '../../../lib/state/headcount-state.js';
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
import { unregisterHeadcount } from '../../../lib/state/active-headcount-tracker.js';
import { createRunRole } from '../../../lib/utilities/run-role-manager.js';

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
    // Replace the organizer panel with the dropdown (don't create new message)
    await btn.update({
        content: '**Select a dungeon to convert to a run**\n\nKey reactions for the selected dungeon will be preserved.',
        components: [createDungeonSelectMenu(dungeonCodes)],
        embeds: [] // Remove the organizer panel embed
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
        
        // Convert the headcount to a run
        // The conversion function will update the same message with the organizer panel
        await convertHeadcountToRun(selectInteraction, publicMsg, selectedCode, btn.user.id);

    } catch (err) {
        // Timeout or other error
        const errorMessage = err instanceof Error 
            ? `Failed to convert headcount: ${err.message}`
            : 'Selection timed out. Please try again.';
        
        await btn.editReply({
            content: errorMessage,
            components: [],
            embeds: []
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
    const dungeonKeyMap = keyOffers.get(dungeonCode);
    
    // Collect all unique users who offered any key type for this dungeon
    const keyUserIds: string[] = [];
    if (dungeonKeyMap) {
        const uniqueUsers = new Set<string>();
        for (const userIds of dungeonKeyMap.values()) {
            userIds.forEach(id => uniqueUsers.add(id));
        }
        keyUserIds.push(...Array.from(uniqueUsers));
    }
    
    const guildId = interaction.guildId!;

    // Create the temporary role for this run
    const role = await createRunRole(interaction.guild, interaction.user.username, dungeon.dungeonName);
    if (!role) {
        await interaction.followUp({
            content: '**Warning:** Failed to create the run role. The run will still be created, but members won\'t be automatically assigned a role.',
            flags: MessageFlags.Ephemeral
        });
        // Continue anyway - role creation failure shouldn't block run creation
    }

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
        autoEndMinutes: getDefaultAutoEndMinutes(),
        roleId: role?.id // Store the created role ID
    }, { guildId });

    // NOTE: We intentionally DO NOT transfer key reactions from headcount to run
    // The run starts fresh - raiders need to click the key buttons again on the run panel

    // Build the run embed
    const runEmbed = new EmbedBuilder()
        .setTitle(`⏳ Starting Soon: ${dungeon.dungeonName}`)
        .setDescription(`Organizer: <@${organizerId}>`)
        .addFields(
            { name: 'Raiders', value: '0', inline: false }
        )
        .setTimestamp(new Date());

    // Add Keys field if the dungeon has key reactions (starting fresh - no keys from headcount)
    if (dungeon.keyReactions && dungeon.keyReactions.length > 0) {
        runEmbed.addFields({ name: 'Keys', value: 'None', inline: false });
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
    clearParticipants(publicMsg.id);
    
    // CRITICAL: Unregister the headcount from active tracking
    // This prevents the "multiple runs" error when using /taken after converting a headcount
    unregisterHeadcount(interaction.guild.id, organizerId);

    // Build the run organizer panel (matching current format from organizer-panel.ts)
    const runOrgPanelEmbed = new EmbedBuilder()
        .setTitle(`Organizer Panel — ${dungeon.dungeonName}`)
        .setTimestamp(new Date());

    // Build description - no keys transferred from headcount
    let description = 'Manage the raid with the controls below.';

    runOrgPanelEmbed.setDescription(description);

    // Starting phase controls (matching organizer-panel.ts format)
    // Row 1: Start, Cancel
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
    
    // Row 2: Set Party/Loc + Chain Amount (if not Oryx 3)
    const orgRow2Components = [
        new ButtonBuilder()
            .setCustomId(`run:setpartyloc:${runId}`)
            .setLabel('Set Party/Loc')
            .setStyle(ButtonStyle.Secondary)
    ];
    
    if (dungeon.codeName !== 'ORYX_3') {
        orgRow2Components.push(
            new ButtonBuilder()
                .setCustomId(`run:setchain:${runId}`)
                .setLabel('Chain Amount')
                .setStyle(ButtonStyle.Secondary)
        );
    }
    
    const orgRow2 = new ActionRowBuilder<ButtonBuilder>().addComponents(...orgRow2Components);
    
    const controls = [orgRow1, orgRow2];
    
    // Row 3: Screenshot button for Oryx 3
    if (dungeon.codeName === 'ORYX_3') {
        const screenshotRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`run:screenshot:${runId}`)
                .setLabel('📸 Submit Screenshot')
                .setStyle(ButtonStyle.Secondary)
        );
        controls.push(screenshotRow);
    }

    // Update the organizer panel message (same ephemeral message) with the run organizer panel
    if (interaction.deferred || interaction.replied) {
        await interaction.editReply({
            content: '', // Clear any content
            embeds: [runOrgPanelEmbed],
            components: controls
        });
    } else {
        await interaction.reply({
            embeds: [runOrgPanelEmbed],
            components: controls,
            flags: MessageFlags.Ephemeral
        });
    }
}
