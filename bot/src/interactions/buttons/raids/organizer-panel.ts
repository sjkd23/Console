import {
    ButtonInteraction,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    MessageEditOptions,
    ModalSubmitInteraction,
    ChatInputCommandInteraction,
    Message
} from 'discord.js';
import { getJSON } from '../../../lib/utilities/http.js';
import { checkOrganizerAccess } from '../../../lib/permissions/interaction-permissions.js';
import { formatKeyLabel, getDungeonKeyEmoji, getDungeonKeyEmojiIdentifier, getEmojiDisplayForKeyType } from '../../../lib/utilities/key-emoji-helpers.js';
import { logButtonClick } from '../../../lib/logging/raid-logger.js';
import { registerOrganizerPanel, RunOrganizerPanelHandle } from '../../../lib/state/organizer-panel-tracker.js';

/**
 * Build the organizer panel content (embed and components) for a run.
 * This is a pure function that doesn't interact with Discord directly.
 * EXPORTED for use by headcount-convert.ts to create consistent organizer panels.
 * 
 * @returns Object with embed and components to display, or null if run has ended
 */
export async function buildRunOrganizerPanelContent(
    runId: number,
    guildId: string,
    confirmationMessage?: string
): Promise<{ embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } | null> {
    // Fetch run data
    const run = await getJSON<{
        status: string;
        dungeonLabel: string;
        dungeonKey: string;
        organizerId: string;
        screenshotUrl?: string | null;
        o3Stage?: string | null;
    }>(`/runs/${runId}`, { guildId }).catch(() => null);

    if (!run) {
        return null;
    }

    // If run has ended, return null to signal no panel should be shown
    if (run.status !== 'open' && run.status !== 'live') {
        return null;
    }

    // Fetch key reaction users
    let headcountKeys: Record<string, string[]> = {};
    let raidKeys: Record<string, string[]> = {};
    const keyUsersResponse = await getJSON<{ 
        headcountKeys: Record<string, string[]>; 
        raidKeys: Record<string, string[]>;
        keyUsers: Record<string, string[]>;
    }>(
        `/runs/${runId}/key-reaction-users`,
        { guildId }
    ).catch(() => ({ headcountKeys: {}, raidKeys: {}, keyUsers: {} }));
    headcountKeys = keyUsersResponse.headcountKeys;
    raidKeys = keyUsersResponse.raidKeys;

    // Fetch raider count
    let joinCount = 0;
    try {
        const countResponse = await getJSON<{ joinCount: number; classCounts: Record<string, number> }>(
            `/runs/${runId}/raiders`,
            { guildId }
        );
        joinCount = countResponse.joinCount || 0;
    } catch (e) {
        console.error('Failed to fetch raider count:', e);
        joinCount = 0;
    }

    // Build panel embed
    const panelEmbed = new EmbedBuilder()
        .setTitle(`Organizer Panel — ${run.dungeonLabel}`)
        .setTimestamp(new Date());

    let description = '';
    
    // Add confirmation message at the top if provided
    if (confirmationMessage) {
        description += `${confirmationMessage}\n\n`;
    }
    
    // Show raider count
    description += `**Raiders Joined:** ${joinCount}\n\n`;
    description += 'Manage the raid with the controls below.';

    // Show Headcount Keys
    if (Object.keys(headcountKeys).length > 0) {
        description += '\n\n**Headcount Keys:**';
        for (const [keyType, userIds] of Object.entries(headcountKeys)) {
            const keyLabel = formatKeyLabel(keyType);
            const keyEmoji = getEmojiDisplayForKeyType(keyType);
            const mentions = userIds.map(id => `<@${id}>`).join(', ');
            description += `\n${keyEmoji} **${keyLabel}** (${userIds.length}): ${mentions}`;
        }
    }

    // Show Raid Keys
    if (Object.keys(raidKeys).length > 0) {
        description += '\n\n**Raid Keys:**';
        for (const [keyType, userIds] of Object.entries(raidKeys)) {
            const keyLabel = formatKeyLabel(keyType);
            const keyEmoji = getEmojiDisplayForKeyType(keyType);
            const mentions = userIds.map(id => `<@${id}>`).join(', ');
            description += `\n${keyEmoji} **${keyLabel}** (${userIds.length}): ${mentions}`;
        }
    }

    panelEmbed.setDescription(description);

    // Build control buttons based on run status
    let controls: ActionRowBuilder<ButtonBuilder>[];

    if (run.status === 'open') {
        // Starting phase
        const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`run:start:${runId}`)
                .setLabel('Start')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`run:cancel:${runId}`)
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Danger)
        );
        
        const row2Components = [
            new ButtonBuilder()
                .setCustomId(`run:setpartyloc:${runId}`)
                .setLabel('Set Party/Loc')
                .setStyle(ButtonStyle.Secondary)
        ];
        
        if (run.dungeonKey !== 'ORYX_3') {
            row2Components.push(
                new ButtonBuilder()
                    .setCustomId(`run:setchain:${runId}`)
                    .setLabel('Chain Amount')
                    .setStyle(ButtonStyle.Secondary)
            );
        }
        
        const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(...row2Components);
        controls = [row1, row2];
        
        // Add screenshot button for Oryx 3
        if (run.dungeonKey === 'ORYX_3') {
            const screenshotRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`run:screenshot:${runId}`)
                    .setLabel(run.screenshotUrl ? '✅ Screenshot Submitted' : '📸 Submit Screenshot')
                    .setStyle(run.screenshotUrl ? ButtonStyle.Success : ButtonStyle.Secondary)
                    .setDisabled(!!run.screenshotUrl)
            );
            controls.push(screenshotRow);
        }
    } else { // run.status === 'live'
        // Live phase
        const actionButtons: ButtonBuilder[] = [];
        
        if (run.dungeonKey === 'ORYX_3') {
            const o3Stage = run.o3Stage || null;
            
            if (!o3Stage) {
                actionButtons.push(
                    new ButtonBuilder()
                        .setCustomId(`run:realmscore:${runId}`)
                        .setLabel('Realm Score %')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId(`run:realmclosed:${runId}`)
                        .setLabel('Realm Closed')
                        .setStyle(ButtonStyle.Primary)
                );
            } else if (o3Stage === 'closed') {
                actionButtons.push(
                    new ButtonBuilder()
                        .setCustomId(`run:miniboss:${runId}`)
                        .setLabel('Miniboss')
                        .setStyle(ButtonStyle.Primary)
                );
            } else if (o3Stage === 'miniboss') {
                actionButtons.push(
                    new ButtonBuilder()
                        .setCustomId(`run:thirdroom:${runId}`)
                        .setLabel('Third Room')
                        .setStyle(ButtonStyle.Success)
                );
            }
        } else {
            const keyPoppedButton = new ButtonBuilder()
                .setCustomId(`run:keypop:${runId}`)
                .setLabel('Key popped')
                .setStyle(ButtonStyle.Success);

            const keyEmojiIdentifier = getDungeonKeyEmojiIdentifier(run.dungeonKey);
            if (keyEmojiIdentifier) {
                keyPoppedButton.setEmoji(keyEmojiIdentifier);
            }
            
            actionButtons.push(keyPoppedButton);
        }

        const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`run:end:${runId}`)
                .setLabel('End Run')
                .setStyle(ButtonStyle.Danger),
            ...actionButtons
        );
        
        const row2Components = [
            new ButtonBuilder()
                .setCustomId(`run:setpartyloc:${runId}`)
                .setLabel('Set Party/Loc')
                .setStyle(ButtonStyle.Secondary)
        ];
        
        if (run.dungeonKey !== 'ORYX_3') {
            row2Components.push(
                new ButtonBuilder()
                    .setCustomId(`run:setchain:${runId}`)
                    .setLabel('Chain Amount')
                    .setStyle(ButtonStyle.Secondary)
            );
        }
        
        row2Components.push(
            new ButtonBuilder()
                .setCustomId(`run:cancel:${runId}`)
                .setLabel('Cancel Run')
                .setStyle(ButtonStyle.Danger)
        );
        
        const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(...row2Components);
        controls = [row1, row2];
    }

    return { embeds: [panelEmbed], components: controls };
}

/**
 * Update a run organizer panel using the appropriate edit method based on handle type.
 * This fixes the "Unknown Message" error by using the correct Discord API method for each panel type.
 * 
 * @param handle The panel handle (knows whether to use editReply, webhook.editMessage, or message.edit)
 * @param runId The run ID
 * @param guildId The guild ID
 * @param confirmationMessage Optional confirmation message to show
 */
export async function updateRunOrganizerPanel(
    handle: RunOrganizerPanelHandle,
    runId: number,
    guildId: string,
    confirmationMessage?: string
): Promise<void> {
    try {
        const content = await buildRunOrganizerPanelContent(runId, guildId, confirmationMessage);
        
        if (!content) {
            // Run has ended - clear the panel
            const endedContent = {
                content: 'This run has ended.',
                embeds: [],
                components: []
            };
            
            switch (handle.type) {
                case 'interactionReply':
                    await handle.interaction.editReply(endedContent);
                    break;
                case 'followup':
                    await handle.webhook.editMessage(handle.messageId, endedContent);
                    break;
                case 'publicMessage':
                    await handle.message.edit(endedContent);
                    break;
            }
            return;
        }

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
        // This is expected behavior - user may have closed the panel or it timed out
        console.error('Failed to update run organizer panel:', err);
    }
}

/**
 * Internal function to build and show the organizer panel.
 * Used by both initial access and confirmed access.
 * @param confirmationMessage Optional message to show at the top of the panel (e.g., "✅ Party set to: USW3")
 */
export async function showOrganizerPanel(
    btn: ButtonInteraction | ModalSubmitInteraction, 
    runId: number, 
    guildId: string, 
    run: {
        status: string;
        dungeonLabel: string;
        dungeonKey: string;
        organizerId: string;
        screenshotUrl?: string | null;
        o3Stage?: string | null; // Track O3 progression: null -> 'closed' -> 'miniboss' -> 'third_room'
    }, 
    confirmationMessage?: string
) {
    // Check if run has ended before building content
    if (run.status !== 'open' && run.status !== 'live') {
        const message = 'This run has ended.';
        if (btn.deferred || btn.replied) {
            await btn.editReply({ content: message, embeds: [], components: [] });
        } else {
            await btn.reply({ content: message, flags: MessageFlags.Ephemeral });
        }
        return;
    }

    // Build panel content
    const content = await buildRunOrganizerPanelContent(runId, guildId, confirmationMessage);
    
    if (!content) {
        const message = 'This run has ended.';
        if (btn.deferred || btn.replied) {
            await btn.editReply({ content: message, embeds: [], components: [] });
        } else {
            await btn.reply({ content: message, flags: MessageFlags.Ephemeral });
        }
        return;
    }

    // Send or update the panel
    if (btn.deferred || btn.replied) {
        await btn.editReply({ embeds: content.embeds, components: content.components });
    } else {
        await btn.reply({ embeds: content.embeds, components: content.components, flags: MessageFlags.Ephemeral });
    }

    // Register this organizer panel for auto-refresh on key reactions
    // Store as an interactionReply handle since this panel was created via interaction.reply()
    registerOrganizerPanel(runId.toString(), btn.user.id, {
        type: 'interactionReply',
        interaction: btn
    });

    // Log organizer panel access
    if (btn.guild) {
        try {
            await logButtonClick(
                btn.client,
                {
                    guildId: btn.guild.id,
                    organizerId: run.organizerId,
                    organizerUsername: '',
                    dungeonName: run.dungeonLabel,
                    type: 'run',
                    runId: runId
                },
                btn.user.id,
                'Organizer Panel',
                'run:org'
            );
        } catch (e) {
            console.error('Failed to log organizer panel access:', e);
        }
    }
}

export async function handleOrganizerPanel(btn: ButtonInteraction, runId: string) {
    const guildId = btn.guildId;
    if (!guildId) {
        await btn.reply({
            content: 'This command can only be used in a server.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    // Fetch run status from backend to determine which buttons to show
    const run = await getJSON<{
        status: string;
        dungeonLabel: string;
        dungeonKey: string;
        organizerId: string;
        screenshotUrl?: string | null;
        o3Stage?: string | null;
    }>(
        `/runs/${runId}`,
        { guildId }
    ).catch(() => null);

    if (!run) {
        await btn.reply({
            content: 'Could not fetch run details.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    // Authorization check using centralized helper
    const accessCheck = await checkOrganizerAccess(btn, run.organizerId);
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
            .setTitle('Confirm Access')
            .setDescription(
                `This run is hosted by <@${run.organizerId}>.\n\n` +
                `Are you sure you want to manage it?\n\n` +
                `Your actions will be logged.`
            )
            .setColor(0xffa500) // Orange color
            .setTimestamp(new Date());

        const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`run:org:confirm:${runId}`)
                .setLabel('Confirm')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`run:org:deny:${runId}`)
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

    // Original organizer - show panel directly
    await showOrganizerPanel(btn, parseInt(runId), guildId, run);
}

/**
 * Handle confirmation when a different organizer wants to manage a run.
 */
export async function handleOrganizerPanelConfirm(btn: ButtonInteraction, runId: string) {
    await btn.deferUpdate();

    const guildId = btn.guildId;
    if (!guildId) {
        await btn.editReply({
            content: 'This command can only be used in a server.',
            embeds: [],
            components: []
        });
        return;
    }

    // Fetch run details
    const run = await getJSON<{
        status: string;
        dungeonLabel: string;
        dungeonKey: string;
        organizerId: string;
        screenshotUrl?: string | null;
        o3Stage?: string | null;
    }>(`/runs/${runId}`, { guildId }).catch(() => null);

    if (!run) {
        await btn.editReply({
            content: 'Could not fetch run details.',
            embeds: [],
            components: []
        });
        return;
    }

    // Verify they still have organizer access
    const accessCheck = await checkOrganizerAccess(btn, run.organizerId);
    if (!accessCheck.allowed) {
        await btn.editReply({
            content: accessCheck.errorMessage,
            embeds: [],
            components: []
        });
        return;
    }

    // Show the full organizer panel
    await showOrganizerPanel(btn, parseInt(runId), guildId, run);
}

/**
 * Handle denial when a different organizer decides not to manage a run.
 */
export async function handleOrganizerPanelDeny(btn: ButtonInteraction, runId: string) {
    await btn.update({
        content: 'Access denied. You can reopen the organizer panel at any time.',
        embeds: [],
        components: []
    });
}

/**
 * Refresh the organizer panel with an optional confirmation message.
 * This is used by action handlers to update the panel instead of sending new ephemeral messages.
 * @param interaction The button or modal submit interaction (must be deferred/replied)
 * @param runId The run ID
 * @param confirmationMessage Optional confirmation message to display at the top
 */
export async function refreshOrganizerPanel(
    interaction: ButtonInteraction | ModalSubmitInteraction,
    runId: string,
    confirmationMessage?: string
) {
    const guildId = interaction.guildId;
    if (!guildId) {
        await interaction.editReply({
            content: 'This command can only be used in a server.',
            embeds: [],
            components: []
        });
        return;
    }

    // Fetch run details
    const run = await getJSON<{
        status: string;
        dungeonLabel: string;
        dungeonKey: string;
        organizerId: string;
        screenshotUrl?: string | null;
        o3Stage?: string | null;
    }>(`/runs/${runId}`, { guildId }).catch(() => null);

    if (!run) {
        await interaction.editReply({
            content: 'Could not fetch run details.',
            embeds: [],
            components: []
        });
        return;
    }

    // Show the updated panel with confirmation message
    await showOrganizerPanel(interaction, parseInt(runId), guildId, run, confirmationMessage);
}

/**
 * Create and send a run organizer panel as a follow-up message (for auto-popup after run creation).
 * This is a clean, interaction-agnostic approach that sends the panel and registers it for live updates.
 * 
 * @param interaction The command interaction (must have been replied to already)
 * @param runId The run ID
 * @param guildId The guild ID
 */
export async function sendRunOrganizerPanelAsFollowUp(
    interaction: ChatInputCommandInteraction,
    runId: number,
    guildId: string
): Promise<void> {
    try {
        // Build panel content
        const content = await buildRunOrganizerPanelContent(runId, guildId);
        
        if (!content) {
            // Run has ended or doesn't exist - silently fail
            return;
        }

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
        registerOrganizerPanel(runId.toString(), interaction.user.id, {
            type: 'followup',
            webhook: interaction.webhook,
            messageId: panelMessage.id
        });

    } catch (err) {
        // Silently fail - organizer can open panel manually if needed
        console.error('Failed to send run organizer panel as follow-up:', err);
    }
}
