import {
    ButtonInteraction,
    StringSelectMenuInteraction,
    StringSelectMenuBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} from 'discord.js';
import { sendO3ProgressionPing } from '../../../lib/utilities/o3-progression.js';
import { refreshOrganizerPanel } from './organizer-panel.js';
import { createLogger } from '../../../lib/logging/logger.js';
import { getRunDetails, patchJSON } from '../../../lib/utilities/http.js';
import { updateRunPublicPanelContent } from '../../../lib/utilities/run-public-panel-updater.js';

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
        // Persist first so stale or repeated interactions cannot emit progression pings.
        await patchJSON(`/runs/${runId}/o3-stage`, { o3Stage: 'closed' }, { guildId });
        const persistedRun = await getRunDetails(runId, guildId);
        if (persistedRun.runKind !== 'oryx_3' || persistedRun.o3Stage !== 'closed') {
            throw new Error(`Realm Closed persistence verification returned O3 stage ${persistedRun.o3Stage ?? 'null'}`);
        }

        logger.info('Realm Closed state persisted; refreshing Discord run messages', {
            runId,
            guildId,
            runStatus: persistedRun.status,
            o3Stage: persistedRun.o3Stage,
            activeRunsMessageId: persistedRun.activeRunsMessageId,
        });

        // Refresh immediately from authoritative backend state. This updates both the
        // normal run message and its existing Active Runs mirror before announcements.
        await updateRunPublicPanelContent(btn.client, guildId, runId);

        // Send the "Realm Closed" ping message
        const pingMessageId = await sendO3ProgressionPing({
            messageText: 'Realm Closed',
            runId: parseInt(runId),
            guild: btn.guild,
            client: btn.client,
            includePartyLocation: false
        });

        logger[pingMessageId ? 'info' : 'warn'](
            pingMessageId ? 'Realm Closed message sent' : 'Realm Closed persisted without a progression ping', {
                runId,
                guildId,
                userId: btn.user.id
            }
        );

        // Refresh the organizer panel with confirmation and updated buttons
        await refreshOrganizerPanel(
            btn,
            runId,
            pingMessageId
                ? '✅ **Realm Closed** message sent (raiders have been pinged!)'
                : '⚠️ **Realm Closed** was saved, but the raider announcement could not be sent.'
        );
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

    await btn.update({
        content: 'Select which miniboss to announce:',
        embeds: [],
        components: [row]
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
        // Persist first so stale selectors cannot emit pings or regress progression.
        await patchJSON(`/runs/${runId}/o3-stage`, { o3Stage: 'miniboss' }, { guildId });

        // Send the "Mini: [Miniboss]" ping message
        const pingMessageId = await sendO3ProgressionPing({
            messageText: `Mini: ${selectedMiniboss}`,
            runId: parseInt(runId),
            guild: interaction.guild,
            client: interaction.client,
            includePartyLocation: false
        });

        logger[pingMessageId ? 'info' : 'warn'](
            pingMessageId ? 'Miniboss announcement sent' : 'Miniboss persisted without a progression ping', {
                runId,
                guildId,
                userId: interaction.user.id,
                miniboss: selectedMiniboss
            }
        );

        await refreshOrganizerPanel(
            interaction,
            runId,
            pingMessageId
                ? `✅ **Mini: ${selectedMiniboss}** announced! Raiders have been pinged.`
                : `⚠️ **Mini: ${selectedMiniboss}** was saved, but the raider announcement could not be sent.`
        );
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
        // Persist first so stale or repeated interactions cannot emit progression pings.
        await patchJSON(`/runs/${runId}/o3-stage`, { o3Stage: 'third_room' }, { guildId });

        // Send the "Third Room - Join Sanctuary now!" ping message
        const pingMessageId = await sendO3ProgressionPing({
            messageText: 'Third Room - Join Sanctuary now!',
            runId: parseInt(runId),
            guild: btn.guild,
            client: btn.client,
            includePartyLocation: false
        });

        logger[pingMessageId ? 'info' : 'warn'](
            pingMessageId ? 'Third Room message sent' : 'Third Room persisted without a progression ping', {
                runId,
                guildId,
                userId: btn.user.id
            }
        );

        // Refresh the organizer panel with confirmation
        await refreshOrganizerPanel(
            btn,
            runId,
            pingMessageId
                ? '✅ **Third Room** announced (raiders have been pinged!)'
                : '⚠️ **Third Room** was saved, but the raider announcement could not be sent.'
        );
    } catch (err) {
        logger.error('Failed to send Third Room message', {
            runId,
            error: err instanceof Error ? err.message : String(err)
        });

        await refreshOrganizerPanel(btn, runId, '❌ Failed to send Third Room message');
    }
}
