import {
    ButtonInteraction,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags
} from 'discord.js';
import { getJSON } from '../../../lib/utilities/http.js';
import { checkOrganizerAccess } from '../../../lib/permissions/interaction-permissions.js';
import { formatKeyLabel, getDungeonKeyEmoji, getDungeonKeyEmojiIdentifier } from '../../../lib/utilities/key-emoji-helpers.js';
import { logButtonClick } from '../../../lib/logging/raid-logger.js';

/**
 * Internal function to build and show the organizer panel.
 * Used by both initial access and confirmed access.
 */
async function showOrganizerPanel(btn: ButtonInteraction, runId: string, run: {
    status: string;
    dungeonLabel: string;
    dungeonKey: string;
    organizerId: string;
}) {
    // Fetch key reaction users if there are key reactions for this dungeon
    let keyUsers: Record<string, string[]> = {};
    const keyUsersResponse = await getJSON<{ keyUsers: Record<string, string[]> }>(
        `/runs/${runId}/key-reaction-users`
    ).catch(() => ({ keyUsers: {} }));
    keyUsers = keyUsersResponse.keyUsers;

    // Use dungeonLabel from run data instead of trying to parse from embed
    // (which might be the confirmation embed if coming from confirm button)
    const dungeonTitle = run.dungeonLabel || 'Raid';

        const panelEmbed = new EmbedBuilder()
            .setTitle(`Organizer Panel — ${dungeonTitle}`)
            .setTimestamp(new Date());

        // Build description with key reaction users if any
        let description = 'Manage the raid with the controls below.';

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
        // Starting phase: Start, Cancel (row 1) + Set Party, Set Location, Chain Amount (row 2)
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
        const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`run:setparty:${runId}`)
                .setLabel('Set Party')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`run:setlocation:${runId}`)
                .setLabel('Set Location')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`run:setchain:${runId}`)
                .setLabel('Chain Amount')
                .setStyle(ButtonStyle.Secondary)
        );
        controls = [row1, row2];
    } else if (run.status === 'live') {
        // Live phase: End, Ping Raiders, Update Note, Key popped (row 1) + Set Party, Set Location (row 2)

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

        const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`run:end:${runId}`)
                .setLabel('End Run')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`run:ping:${runId}`)
                .setLabel('Ping Raiders')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`run:note:${runId}`)
                .setLabel('Update Note')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true), // Placeholder for future implementation
            keyPoppedButton
        );
        const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`run:setparty:${runId}`)
                .setLabel('Set Party')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`run:setlocation:${runId}`)
                .setLabel('Set Location')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`run:setchain:${runId}`)
                .setLabel('Chain Amount')
                .setStyle(ButtonStyle.Secondary)
        );
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
                    runId: parseInt(runId)
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
    // Fetch run status from backend to determine which buttons to show
    const run = await getJSON<{
        status: string;
        dungeonLabel: string;
        dungeonKey: string;
        organizerId: string;
    }>(
        `/runs/${runId}`
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
            .setTitle('⚠️ Confirm Access')
            .setDescription(
                `This run is hosted by <@${run.organizerId}>.\n\n` +
                `Are you sure you want to manage it?\n\n` +
                `Your actions will be logged under your name.`
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
    await showOrganizerPanel(btn, runId, run);
}

/**
 * Handle confirmation when a different organizer wants to manage a run.
 */
export async function handleOrganizerPanelConfirm(btn: ButtonInteraction, runId: string) {
    await btn.deferUpdate();

    // Fetch run details
    const run = await getJSON<{
        status: string;
        dungeonLabel: string;
        dungeonKey: string;
        organizerId: string;
    }>(`/runs/${runId}`).catch(() => null);

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
    await showOrganizerPanel(btn, runId, run);
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
