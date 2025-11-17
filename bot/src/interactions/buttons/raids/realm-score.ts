import { 
    ButtonInteraction, 
    ChannelType, 
    EmbedBuilder, 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle, 
    ActionRowBuilder,
    ModalActionRowComponentBuilder 
} from 'discord.js';
import { getJSON, patchJSON } from '../../../lib/utilities/http.js';
import { createLogger } from '../../../lib/logging/logger.js';
import { sendRealmScorePing } from '../../../lib/utilities/run-ping.js';

const logger = createLogger('RealmScore');

/**
 * Handle "Realm Score %" button press for Oryx 3 runs.
 * Shows a modal for realm score input (1-99), updates the embed, and pings without a timer.
 */
export async function handleRealmScore(btn: ButtonInteraction, runId: string) {
    // Show modal for realm score input
    const modal = new ModalBuilder()
        .setCustomId(`modal:realmscore:${runId}`)
        .setTitle('Set Realm Score %');

    const scoreInput = new TextInputBuilder()
        .setCustomId('score')
        .setLabel('Realm Score (1-99%)')
        .setPlaceholder('e.g., 85 for 85%')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(2);

    const row = new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(scoreInput);
    modal.addComponents(row);

    await btn.showModal(modal);

    // Wait for modal submission
    try {
        const submitted = await btn.awaitModalSubmit({
            time: 120000, // 2 minutes
            filter: i => i.customId === `modal:realmscore:${runId}` && i.user.id === btn.user.id
        });

        await submitted.deferUpdate();

        const scoreStr = submitted.fields.getTextInputValue('score').trim();
        const scoreValue = parseInt(scoreStr);

        // Validate input
        if (isNaN(scoreValue) || scoreValue < 1 || scoreValue > 99) {
            await submitted.followUp({ 
                content: '❌ Realm score must be a number between 1 and 99', 
                ephemeral: true 
            });
            return;
        }

        const guildId = btn.guildId;
        if (!guildId) {
            await submitted.followUp({ 
                content: 'This command can only be used in a server.', 
                ephemeral: true 
            });
            return;
        }

        // Store the realm score in the run (using description field for now, or we could add a new field)
        // For now, we'll just fetch the run and update the embed without storing in DB
        // Fetch full run details to rebuild embed
        const run = await getJSON<{
            channelId: string | null;
            postMessageId: string | null;
            status: string;
            dungeonKey: string;
            dungeonLabel: string;
            organizerId: string;
            startedAt: string | null;
            party: string | null;
            location: string | null;
            description: string | null;
        }>(`/runs/${runId}`, { guildId });

        if (!run.channelId || !run.postMessageId) {
            await submitted.followUp({ 
                content: 'Run record missing channel/message id.', 
                ephemeral: true 
            });
            return;
        }

        const ch = await btn.client.channels.fetch(run.channelId).catch(() => null);
        if (!ch || ch.type !== ChannelType.GuildText) {
            await submitted.followUp({ 
                content: 'Could not locate run channel.', 
                ephemeral: true 
            });
            return;
        }

        const pubMsg = await ch.messages.fetch(run.postMessageId).catch(() => null);
        if (!pubMsg) {
            await submitted.followUp({ 
                content: 'Public run message no longer exists.', 
                ephemeral: true 
            });
            return;
        }

        // Update the embed with the realm score
        const embeds = pubMsg.embeds ?? [];
        if (!embeds.length) {
            await submitted.followUp({ 
                content: 'Could not find run embed.', 
                ephemeral: true 
            });
            return;
        }

        const updatedEmbed = buildLiveEmbedWithRealmScore(embeds[0], run, scoreValue);

        await pubMsg.edit({ embeds: [updatedEmbed, ...embeds.slice(1)] });

        // Send realm score ping message (NO TIMER - this is the key difference from key popped)
        if (btn.guild) {
            await sendRealmScorePing(btn.client, parseInt(runId), btn.guild, scoreValue);
        }

        // Log realm score update to raid-log
        logger.info('Realm score updated for O3 run', {
            runId,
            guildId,
            userId: btn.user.id,
            realmScore: scoreValue
        });

        // Confirm to organizer
        await submitted.followUp({ 
            content: `✅ Realm score set to ${scoreValue}% and raiders have been pinged!`, 
            ephemeral: true 
        });

    } catch (err) {
        logger.error('Failed to set realm score', {
            runId,
            error: err instanceof Error ? err.message : String(err)
        });
        
        // If modal wasn't submitted in time, don't do anything (user closed it)
        if (err instanceof Error && err.message.includes('time')) {
            return;
        }
    }
}

/**
 * Build the Live phase embed with realm score displayed.
 */
function buildLiveEmbedWithRealmScore(
    original: any,
    run: {
        dungeonKey: string;
        dungeonLabel: string;
        organizerId: string;
        startedAt: string | null;
        party: string | null;
        location: string | null;
        description: string | null;
    },
    realmScore: number
): EmbedBuilder {
    const embed = EmbedBuilder.from(original);

    // Set title with LIVE badge (no chain tracking for O3)
    embed.setTitle(`🟢 LIVE: ${run.dungeonLabel}`);

    // Build description with organizer and realm score
    let desc = `Organizer: <@${run.organizerId}>`;
    desc += `\n\n**Realm Score:** ${realmScore}%`;

    embed.setDescription(desc);

    // Keep existing fields (Raiders, Keys, etc.) but remove Party/Location and Classes
    const data = embed.toJSON();
    const fields = [...(data.fields ?? [])];

    // Remove Party field if present
    const partyIdx = fields.findIndex(f => (f.name ?? '').toLowerCase() === 'party');
    if (partyIdx >= 0) {
        fields.splice(partyIdx, 1);
    }

    // Remove Location field if present
    const locIdx = fields.findIndex(f => (f.name ?? '').toLowerCase() === 'location');
    if (locIdx >= 0) {
        fields.splice(locIdx, 1);
    }

    // Remove Classes field if present
    const classIdx = fields.findIndex(f => (f.name ?? '').toLowerCase() === 'classes');
    if (classIdx >= 0) {
        fields.splice(classIdx, 1);
    }

    // Update or add Organizer Note field
    if (run.description) {
        const noteIdx = fields.findIndex(f => (f.name ?? '').toLowerCase() === 'organizer note');
        if (noteIdx >= 0) {
            fields[noteIdx] = { ...fields[noteIdx], value: run.description };
        }
    }

    return embed.setFields(fields as any);
}
