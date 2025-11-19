import {
    ButtonInteraction,
    StringSelectMenuInteraction,
    StringSelectMenuBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags
} from 'discord.js';
import { sendO3ProgressionPing } from '../../../lib/utilities/o3-progression.js';
import { refreshOrganizerPanel } from './organizer-panel.js';
import { createLogger } from '../../../lib/logging/logger.js';
import { patchJSON } from '../../../lib/utilities/http.js';

const logger = createLogger('O3Progression');

/**
 * Handle "Realm Closed" button press for Oryx 3 runs.
 * Posts "Realm Closed" message and replaces Realm Closed/Realm Score buttons with Miniboss button.
 */
export async function handleRealmClosed(btn: ButtonInteraction, runId: string) {
    await btn.deferUpdate();

    const guildId = btn.guildId;
    if (!guildId || !btn.guild) {
        await btn.editReply({
            content: 'This command can only be used in a server.',
            embeds: [],
            components: []
        });
        return;
    }

    try {
        // Send the "Realm Closed" ping message
        await sendO3ProgressionPing({
            messageText: 'Realm Closed',
            runId: parseInt(runId),
            guild: btn.guild,
            client: btn.client,
            includePartyLocation: true
        });

        // Update the O3 stage to 'closed'
        await patchJSON(`/runs/${runId}/o3-stage`, { o3Stage: 'closed' }, { guildId });

        logger.info('Realm Closed message sent', {
            runId,
            guildId,
            userId: btn.user.id
        });

        // Refresh the organizer panel with confirmation and updated buttons
        await refreshOrganizerPanel(btn, runId, '✅ **Realm Closed** message sent (raiders have been pinged!)');
    } catch (err) {
        logger.error('Failed to send Realm Closed message', {
            runId,
            error: err instanceof Error ? err.message : String(err)
        });

        await refreshOrganizerPanel(btn, runId, '❌ Failed to send Realm Closed message');
    }
}

/**
 * Handle "Miniboss" button press for Oryx 3 runs.
 * Shows a dropdown with the four miniboss options.
 */
export async function handleMiniboss(btn: ButtonInteraction, runId: string) {
    // Show a dropdown menu with the four miniboss options
    const minibossSelect = new StringSelectMenuBuilder()
        .setCustomId(`run:miniboss_select:${runId}`)
        .setPlaceholder('Select a miniboss')
        .addOptions([
            {
                label: 'Dammah',
                value: 'Dammah',
                description: 'The Magical Sentinel'
            },
            {
                label: 'Gemsbok',
                value: 'Gemsbok',
                description: 'The Forgotten Sentinel'
            },
            {
                label: 'Leucoryx',
                value: 'Leucoryx',
                description: 'The Untainted Sentinel'
            },
            {
                label: 'Beisa',
                value: 'Beisa',
                description: 'The Permafrost Sentinel'
            }
        ]);

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(minibossSelect);

    await btn.reply({
        content: 'Select which miniboss to announce:',
        components: [row],
        flags: MessageFlags.Ephemeral
    });
}

/**
 * Handle miniboss selection from the dropdown.
 * Posts "Mini: [Miniboss Name]" message and replaces Miniboss button with Third Room button.
 */
export async function handleMinibossSelect(interaction: StringSelectMenuInteraction, runId: string) {
    await interaction.deferUpdate();

    const guildId = interaction.guildId;
    if (!guildId || !interaction.guild) {
        await interaction.editReply({
            content: 'This command can only be used in a server.',
            components: []
        });
        return;
    }

    const selectedMiniboss = interaction.values[0];

    try {
        // Send the "Mini: [Miniboss]" ping message
        await sendO3ProgressionPing({
            messageText: `Mini: ${selectedMiniboss}`,
            runId: parseInt(runId),
            guild: interaction.guild,
            client: interaction.client,
            includePartyLocation: true
        });

        // Update the O3 stage to 'miniboss'
        await patchJSON(`/runs/${runId}/o3-stage`, { o3Stage: 'miniboss' }, { guildId });

        logger.info('Miniboss announcement sent', {
            runId,
            guildId,
            userId: interaction.user.id,
            miniboss: selectedMiniboss
        });

        // Close the dropdown message and refresh organizer panel
        await interaction.deleteReply();

        // Need to get the original button interaction to refresh the panel
        // Since we're in a select menu interaction, we need to fetch and update differently
        // For now, just send a simple confirmation
        await interaction.followUp({
            content: `✅ **Mini: ${selectedMiniboss}** announced! Raiders have been pinged. Open the Organizer Panel to continue.`,
            flags: MessageFlags.Ephemeral
        });
    } catch (err) {
        logger.error('Failed to send miniboss announcement', {
            runId,
            miniboss: selectedMiniboss,
            error: err instanceof Error ? err.message : String(err)
        });

        await interaction.editReply({
            content: `❌ Failed to send miniboss announcement`,
            components: []
        });
    }
}

/**
 * Handle "Third Room" button press for Oryx 3 runs.
 * Posts "Third Room - Join Sanctuary now!" message with role ping.
 */
export async function handleThirdRoom(btn: ButtonInteraction, runId: string) {
    await btn.deferUpdate();

    const guildId = btn.guildId;
    if (!guildId || !btn.guild) {
        await btn.editReply({
            content: 'This command can only be used in a server.',
            embeds: [],
            components: []
        });
        return;
    }

    try {
        // Send the "Third Room - Join Sanctuary now!" ping message
        await sendO3ProgressionPing({
            messageText: 'Third Room - Join Sanctuary now!',
            runId: parseInt(runId),
            guild: btn.guild,
            client: btn.client,
            includePartyLocation: true
        });

        // Update the O3 stage to 'third_room'
        await patchJSON(`/runs/${runId}/o3-stage`, { o3Stage: 'third_room' }, { guildId });

        logger.info('Third Room message sent', {
            runId,
            guildId,
            userId: btn.user.id
        });

        // Refresh the organizer panel with confirmation
        await refreshOrganizerPanel(btn, runId, '✅ **Third Room** announced (raiders have been pinged!)');
    } catch (err) {
        logger.error('Failed to send Third Room message', {
            runId,
            error: err instanceof Error ? err.message : String(err)
        });

        await refreshOrganizerPanel(btn, runId, '❌ Failed to send Third Room message');
    }
}
