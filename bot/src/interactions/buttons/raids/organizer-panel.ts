import {
    ButtonInteraction,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    MessageEditOptions,
    ModalSubmitInteraction
} from 'discord.js';
import { getJSON } from '../../../lib/utilities/http.js';
import { checkOrganizerAccess } from '../../../lib/permissions/interaction-permissions.js';
import { formatKeyLabel, getDungeonKeyEmoji, getDungeonKeyEmojiIdentifier } from '../../../lib/utilities/key-emoji-helpers.js';
import { logButtonClick } from '../../../lib/logging/raid-logger.js';

/**
 * Internal function to build and show the organizer panel.
 * Used by both initial access and confirmed access.
 * @param confirmationMessage Optional message to show at the top of the panel (e.g., "✅ Party set to: USW3")
 */
async function showOrganizerPanel(
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
    // Fetch key reaction users if there are key reactions for this dungeon
    let keyUsers: Record<string, string[]> = {};
    const keyUsersResponse = await getJSON<{ keyUsers: Record<string, string[]> }>(
        `/runs/${runId}/key-reaction-users`,
        { guildId }
    ).catch(() => ({ keyUsers: {} }));
    keyUsers = keyUsersResponse.keyUsers;

    // Use dungeonLabel from run data instead of trying to parse from embed
    // (which might be the confirmation embed if coming from confirm button)
    const dungeonTitle = run.dungeonLabel || 'Raid';

        const panelEmbed = new EmbedBuilder()
            .setTitle(`Organizer Panel — ${dungeonTitle}`)
            .setTimestamp(new Date());

        // Build description with key reaction users if any
        let description = '';
        
        // Add confirmation message at the top if provided
        if (confirmationMessage) {
            description += `${confirmationMessage}\n\n`;
        }
        
        description += 'Manage the raid with the controls below.';

        if (Object.keys(keyUsers).length > 0) {
            description += '\n\n**Key Reacts:**';        // Get the dungeon-specific key emoji (all keys for this dungeon use the same emoji)
        const dungeonKeyEmoji = getDungeonKeyEmoji(run.dungeonKey);
        
        for (const [keyType, userIds] of Object.entries(keyUsers)) {
            const keyLabel = formatKeyLabel(keyType);

            // Create user mentions
            const mentions = userIds.map(id => `<@${id}>`).join(', ');
            description += `\n${dungeonKeyEmoji} **${keyLabel}** (${userIds.length}): ${mentions}`;

        }
    }

    panelEmbed.setDescription(description);

    let controls: ActionRowBuilder<ButtonBuilder>[];

    if (run.status === 'open') {
        // Starting phase: Start, Cancel (row 1) + Set Party/Loc, Chain Amount (row 2)
        // For Oryx 3: Add screenshot instruction button if not yet submitted (row 3)
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
        
        // For Oryx 3, don't show Chain Amount button
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
        
        // Add screenshot instruction button for Oryx 3 if not yet submitted
        if (run.dungeonKey === 'ORYX_3') {
            const screenshotRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`run:screenshot:${runId}`)
                    .setLabel(run.screenshotUrl ? '✅ Screenshot Submitted' : '📸 Submit Screenshot')
                    .setStyle(run.screenshotUrl ? ButtonStyle.Success : ButtonStyle.Secondary)
                    .setDisabled(!!run.screenshotUrl) // Disable if already submitted
            );
            controls.push(screenshotRow);
        }
    } else if (run.status === 'live') {
        // Live phase: End, Ping Raiders, Update Note, Key popped/Realm Score (row 1) + Set Party/Loc, Chain Amount, Cancel (row 2)

        // For Oryx 3, show progression buttons based on current stage
        const actionButtons: ButtonBuilder[] = [];
        
        if (run.dungeonKey === 'ORYX_3') {
            // Oryx 3 progression flow based on stage
            const o3Stage = run.o3Stage || null;
            
            if (!o3Stage) {
                // Initial stage: Show Realm Score % and Realm Closed buttons
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
                // After Realm Closed: Show Miniboss button
                actionButtons.push(
                    new ButtonBuilder()
                        .setCustomId(`run:miniboss:${runId}`)
                        .setLabel('Miniboss')
                        .setStyle(ButtonStyle.Primary)
                );
            } else if (o3Stage === 'miniboss') {
                // After Miniboss selected: Show Third Room button
                actionButtons.push(
                    new ButtonBuilder()
                        .setCustomId(`run:thirdroom:${runId}`)
                        .setLabel('Third Room')
                        .setStyle(ButtonStyle.Success)
                );
            }
            // After Third Room is clicked, no more progression buttons (o3Stage === 'third_room')
        } else {
            // Build the "Key popped" button with the appropriate emoji
            const keyPoppedButton = new ButtonBuilder()
                .setCustomId(`run:keypop:${runId}`)
                .setLabel('Key popped')
                .setStyle(ButtonStyle.Success);

            // Add emoji from the dungeon's first key reaction if available
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
            new ButtonBuilder()
                .setCustomId(`run:ping:${runId}`)
                .setLabel('Ping Raiders')
                .setStyle(ButtonStyle.Primary),
            ...actionButtons
        );
        
        // For Oryx 3, don't show Chain Amount button
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
    } else {
        // Ended phase: no controls
        const message = 'This run has ended.';
        if (btn.deferred || btn.replied) {
            await btn.editReply({ content: message, embeds: [], components: [] });
        } else {
            await btn.reply({ content: message, flags: MessageFlags.Ephemeral });
        }
        return;
    }

    if (btn.deferred || btn.replied) {
        await btn.editReply({ embeds: [panelEmbed], components: controls });
    } else {
        await btn.reply({ embeds: [panelEmbed], components: controls, flags: MessageFlags.Ephemeral });
    }

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
