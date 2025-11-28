import {
    ButtonInteraction,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    StringSelectMenuBuilder,
    ComponentType,
    Message,
    ChatInputCommandInteraction,
    ModalSubmitInteraction
} from 'discord.js';
import { getParticipants, getOrganizerId } from '../../../lib/state/headcount-state.js';
import { getKeyOffers } from './headcount-key.js';
import { dungeonByCode } from '../../../constants/dungeons/dungeon-helpers.js';
import { getDungeonKeyEmoji } from '../../../lib/utilities/key-emoji-helpers.js';
import { checkOrganizerAccess } from '../../../lib/permissions/interaction-permissions.js';
import { getReactionInfo } from '../../../constants/emojis/MappedAfkCheckReactions.js';
import { registerHeadcountPanel, HeadcountOrganizerPanelHandle } from '../../../lib/state/headcount-panel-tracker.js';

/**
 * Format key type for user-friendly display
 */
function formatKeyTypeForDisplay(mapKey: string): string {
    const specialCases: Record<string, string> = {
        'WC_INC': 'Inc',
        'SHIELD_RUNE': 'Shield',
        'SWORD_RUNE': 'Sword',
        'HELM_RUNE': 'Helm',
    };
    
    return specialCases[mapKey] || mapKey.replace(/_/g, ' ');
}

/**
 * Get emoji display string for a key type.
 */
function getEmojiDisplayForKeyType(keyType: string): string {
    const reactionInfo = getReactionInfo(keyType);
    if (!reactionInfo?.emojiInfo?.identifier) return '🗝️';

    const idOrChar = reactionInfo.emojiInfo.identifier;

    if (reactionInfo.emojiInfo.isCustom) {
        return `<:key:${idOrChar}>`;
    }

    return idOrChar;
}

/**
 * Build the headcount organizer panel content (embed and components).
 * This is a pure function that doesn't interact with Discord directly.
 * 
 * @returns Object with embed and components to display
 */
function buildHeadcountOrganizerPanelContent(
    publicMsg: Message,
    embed: EmbedBuilder,
    dungeonCodes: string[]
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
    // Get headcount state
    const participants = getParticipants(embed, publicMsg.id);
    const keyOffers = getKeyOffers(publicMsg.id);

    // Build organizer panel embed
    const panelEmbed = new EmbedBuilder()
        .setTitle('🎯 Headcount Organizer Panel')
        .setColor(0x5865F2)
        .setTimestamp(new Date());

    // Build description with participant count and key offers
    let description = `**Participants:** ${participants.size}\n\n**Keys:**\n`;

    if (dungeonCodes.length === 0) {
        description += '_No dungeons found_';
    } else {
        let hasAnyKeys = false;
        
        for (const dungeonCode of dungeonCodes) {
            const dungeon = dungeonByCode[dungeonCode];
            const dungeonName = dungeon?.dungeonName || dungeonCode;
            
            // Check if this dungeon has multiple key types defined
            const dungeonHasMultipleKeyTypes = dungeon?.keyReactions && dungeon.keyReactions.length > 1;
            
            // Get all key types for this dungeon
            const dungeonKeyMap = keyOffers.get(dungeonCode);
            
            if (dungeonKeyMap && dungeonKeyMap.size > 0) {
                // Show each key type separately
                for (const [mapKey, userIds] of dungeonKeyMap.entries()) {
                    const count = userIds.size;
                    
                    // Only show keys that have a count > 0
                    if (count > 0) {
                        hasAnyKeys = true;
                        const keyEmoji = getEmojiDisplayForKeyType(mapKey);
                        const keyTypeName = formatKeyTypeForDisplay(mapKey);
                        
                        // For dungeons with multiple key types (like Oryx 3), show just "Key Type"
                        // For single-key dungeons, show "Dungeon"
                        const label = dungeonHasMultipleKeyTypes ? keyTypeName : dungeonName;
                        
                        const mentions = Array.from(userIds).map(id => `<@${id}>`).join(', ');
                        description += `\n${keyEmoji} **${label}** (${count}): ${mentions}`;
                    }
                }
            }
        }
        
        // If no keys at all, show a message
        if (!hasAnyKeys) {
            description += '_No keys yet_';
        }
    }

    description += '\n\n**Actions:**\n• Click **End** to close this headcount\n• Click **Convert to Run** to turn a dungeon into a run panel';

    panelEmbed.setDescription(description);

    // Build control buttons
    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`headcount:end:${publicMsg.id}`)
            .setLabel('End Headcount')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`headcount:convert:${publicMsg.id}`)
            .setLabel('Convert to Run')
            .setStyle(ButtonStyle.Success)
            .setDisabled(dungeonCodes.length === 0)
    );

    return { embeds: [panelEmbed], components: [row1] };
}

/**
 * Update a headcount organizer panel using the appropriate edit method based on handle type.
 * This fixes the "Unknown Message" error by using the correct Discord API method for each panel type.
 * 
 * @param handle The panel handle (knows whether to use editReply, webhook.editMessage, or message.edit)
 * @param publicMsg The public headcount message
 * @param embed The headcount embed
 * @param dungeonCodes The dungeon codes for this headcount
 */
export async function updateHeadcountOrganizerPanel(
    handle: HeadcountOrganizerPanelHandle,
    publicMsg: Message,
    embed: EmbedBuilder,
    dungeonCodes: string[]
): Promise<void> {
    try {
        const content = buildHeadcountOrganizerPanelContent(publicMsg, embed, dungeonCodes);
        
        // Update the panel with fresh content using the correct edit method
        const updateContent = {
            embeds: content.embeds,
            components: content.components
        };

        switch (handle.type) {
            case 'interactionReply':
                await handle.interaction.editReply(updateContent);
                break;
            case 'followup':
                await handle.webhook.editMessage(handle.messageId, updateContent);
                break;
            case 'publicMessage':
                await handle.message.edit(updateContent);
                break;
        }
    } catch (err) {
        // Panel might be deleted or ephemeral expired
        console.error('Failed to update headcount organizer panel:', err);
    }
}

/**
 * Build and show the headcount organizer panel.
 * Used by button handler and auto-refresh system.
 * EXPORTED for use by headcount-key.ts to refresh panels when keys are reacted.
 */
export async function showHeadcountPanel(
    interaction: ButtonInteraction | ChatInputCommandInteraction | ModalSubmitInteraction,
    publicMsg: Message,
    embed: EmbedBuilder,
    organizerId: string,
    dungeonCodes: string[]
) {
    // Build panel content
    const content = buildHeadcountOrganizerPanelContent(publicMsg, embed, dungeonCodes);

    // Send or update the panel
    if (interaction.deferred || interaction.replied) {
        await interaction.editReply({
            embeds: content.embeds,
            components: content.components
        });
    } else {
        await interaction.reply({
            embeds: content.embeds,
            components: content.components,
            flags: MessageFlags.Ephemeral
        });
    }
    
    // Register this panel for auto-refresh when keys are reacted
    // Store as an interactionReply handle since this was created via interaction.reply()
    registerHeadcountPanel(publicMsg.id, {
        type: 'interactionReply',
        interaction
    });
}

export async function handleHeadcountOrganizerPanel(btn: ButtonInteraction, panelTimestamp: string) {
    // btn.message is the PUBLIC headcount panel message
    const publicMsg = btn.message;
    const embeds = publicMsg.embeds ?? [];
    
    if (!embeds.length) {
        await btn.reply({
            content: 'Could not fetch headcount panel details.',
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

    // If not the original organizer, show confirmation panel first
    if (!accessCheck.isOriginalOrganizer) {
        const confirmEmbed = new EmbedBuilder()
            .setTitle('⚠️ Confirmation Required')
            .setDescription(
                `This headcount is being hosted by <@${organizerId}>.\n\n` +
                `Are you sure you want to manage it?\n\n` +
                `**Note:** Your actions will be logged under your name.`
            )
            .setColor(0xffa500) // Orange color
            .setTimestamp(new Date());

        const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`headcount:org:confirm:${publicMsg.id}`)
                .setLabel('Confirm')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`headcount:org:deny:${publicMsg.id}`)
                .setLabel('Deny')
                .setStyle(ButtonStyle.Danger)
        );

        await btn.reply({
            embeds: [confirmEmbed],
            components: [confirmRow],
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

    // Original organizer - show panel directly
    await showHeadcountPanel(btn, publicMsg, embed, organizerId, dungeonCodes);
}

/**
 * Handle confirmation when a different organizer wants to manage a headcount.
 */
export async function handleHeadcountOrganizerPanelConfirm(btn: ButtonInteraction, publicMessageId: string) {
    await btn.deferUpdate();

    // Fetch the public headcount message
    const publicMsg = await btn.channel?.messages.fetch(publicMessageId).catch(() => null);
    if (!publicMsg) {
        await btn.editReply({
            content: 'Could not find headcount panel message.',
            embeds: [],
            components: []
        });
        return;
    }

    const embeds = publicMsg.embeds ?? [];
    if (!embeds.length) {
        await btn.editReply({
            content: 'Could not find headcount panel.',
            embeds: [],
            components: []
        });
        return;
    }

    const embed = EmbedBuilder.from(embeds[0]);
    const organizerId = getOrganizerId(embed);

    if (!organizerId) {
        await btn.editReply({
            content: 'Could not determine the headcount organizer.',
            embeds: [],
            components: []
        });
        return;
    }

    // Verify they still have organizer access
    const accessCheck = await checkOrganizerAccess(btn, organizerId);
    if (!accessCheck.allowed) {
        await btn.editReply({
            content: accessCheck.errorMessage,
            embeds: [],
            components: []
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

    // Show the full headcount panel
    await showHeadcountPanel(btn, publicMsg, embed, organizerId, dungeonCodes);
}

/**
 * Handle denial when a different organizer decides not to manage a headcount.
 */
export async function handleHeadcountOrganizerPanelDeny(btn: ButtonInteraction, publicMessageId: string) {
    await btn.update({
        content: 'Access denied. You can reopen the organizer panel at any time.',
        embeds: [],
        components: []
    });
}

/**
 * Create and send a headcount organizer panel as a follow-up message (for auto-popup after headcount creation).
 * This allows the organizer to immediately manage the headcount after creating it.
 * 
 * @param interaction The command interaction (must have been replied to already)
 * @param publicMsg The public headcount message that was posted
 * @param embed The headcount embed
 * @param dungeonCodes The dungeon codes for this headcount
 */
export async function sendHeadcountOrganizerPanelAsFollowUp(
    interaction: ChatInputCommandInteraction,
    publicMsg: Message,
    embed: EmbedBuilder,
    dungeonCodes: string[]
): Promise<void> {
    try {
        // Build panel content
        const content = buildHeadcountOrganizerPanelContent(publicMsg, embed, dungeonCodes);

        // Send as ephemeral follow-up and get the Message object
        const panelMessage = await interaction.followUp({
            embeds: content.embeds,
            components: content.components,
            flags: MessageFlags.Ephemeral,
            fetchReply: true // Get the message ID for later editing
        }) as Message;

        // Register this panel for live updates
        // Store as a followup handle since this was created via interaction.followUp()
        // This is the KEY fix: followup messages must be edited via webhook.editMessage(), not message.edit()
        registerHeadcountPanel(publicMsg.id, {
            type: 'followup',
            webhook: interaction.webhook,
            messageId: panelMessage.id
        });

    } catch (err) {
        // Silently fail - organizer can open panel manually if needed
        console.error('Failed to send headcount organizer panel as follow-up:', err);
    }
}
