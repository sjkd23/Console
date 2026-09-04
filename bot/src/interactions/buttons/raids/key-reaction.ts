import {
    ButtonInteraction,
    EmbedBuilder,
    MessageFlags,
    ModalSubmitInteraction,
    type Message,
} from 'discord.js';
import { dungeonByCode } from '../../../constants/dungeons/dungeon-helpers.js';
import { logKeyReaction } from '../../../lib/logging/raid-logger.js';
import { getAllOrganizerPanelsForRun } from '../../../lib/state/organizer-panel-tracker.js';
import {
    deleteJSON,
    getRunDetails,
    getRunDisplayLabel,
    postJSON,
    type RunDetails,
} from '../../../lib/utilities/http.js';
import {
    buildKeyQuantityModal,
    buildWithdrawKeyButton,
    KeyOfferResponseSchema,
    type KeyOffersByType,
    type KeyQuantityIntent,
    parseKeyQuantity,
    serializeKeyRefresh,
    totalKeyQuantity,
    KEY_QUANTITY_INPUT_ID,
} from '../../../lib/utilities/key-quantity.js';
import { formatKeyLabel, getEmojiDisplayForKeyType } from '../../../lib/utilities/key-emoji-helpers.js';
import { hasBeenNotified, markAsNotified, sendKeyReactorDM } from '../../../lib/utilities/key-reactor-notifications.js';
import { updateRunOrganizerPanel } from './organizer-panel.js';

function isRunAcceptingKeyOffers(run: RunDetails): boolean {
    return (run.status === 'open' || run.status === 'live')
        && !(run.runKind === 'oryx_3' && run.o3Stage !== null);
}

function isKeyAvailableForRun(run: RunDetails, keyType: string): boolean {
    return run.selectedDungeons.some(selection =>
        dungeonByCode[selection.dungeonKey]?.keyReactions.some(reaction => reaction.mapKey === keyType)
    );
}

function truncateFieldValue(value: string): string {
    return value.length <= 1024 ? value : `${value.slice(0, 1021)}...`;
}

export function updateRunKeysField(embed: EmbedBuilder, keyOffers: KeyOffersByType): EmbedBuilder {
    const data = embed.toJSON();
    const fields = [...(data.fields ?? [])];
    const entries = Object.entries(keyOffers)
        .filter(([, users]) => users.length > 0)
        .map(([keyType, users]) => {
            const total = totalKeyQuantity(users);
            const emoji = getEmojiDisplayForKeyType(keyType) || '🗝️';
            return `${emoji} ${formatKeyLabel(keyType)}: ${total}`;
        });
    const keysText = entries.length === 0 ? 'None' : truncateFieldValue(entries.join('\n'));
    const index = fields.findIndex(field => (field.name ?? '').toLowerCase() === 'keys');
    if (index >= 0) fields[index] = { ...fields[index], value: keysText };
    else fields.unshift({ name: 'Keys', value: keysText, inline: false });
    return new EmbedBuilder(data).setFields(fields);
}

async function fetchRunMessage(interaction: ButtonInteraction | ModalSubmitInteraction, run: RunDetails): Promise<Message<true> | null> {
    if (!interaction.guild || !run.channelId || !run.postMessageId) return null;
    const channel = await interaction.guild.channels.fetch(run.channelId).catch(() => null);
    if (!channel?.isTextBased()) return null;
    return channel.messages.fetch(run.postMessageId).catch(() => null);
}

async function refreshRunDisplays(
    runId: string,
    guildId: string,
    publicMessage: Message<true> | null,
    keyOffers: KeyOffersByType
): Promise<void> {
    if (publicMessage?.embeds[0]) {
        const updated = updateRunKeysField(EmbedBuilder.from(publicMessage.embeds[0]), keyOffers);
        await publicMessage.edit({ embeds: [updated, ...publicMessage.embeds.slice(1)] });
    }
    for (const { handle } of getAllOrganizerPanelsForRun(runId)) {
        await updateRunOrganizerPanel(handle, Number(runId), guildId);
    }
}

export async function handleKeyReaction(btn: ButtonInteraction, runId: string, keyType: string): Promise<void> {
    const guildId = btn.guildId;
    if (!guildId || btn.user.bot) {
        await btn.reply({ content: '❌ You cannot interact with this run.', flags: MessageFlags.Ephemeral });
        return;
    }
    // Modal responses must be immediate. The opaque intent is fully revalidated
    // against the backend run and selected dungeons when it is submitted.
    const intent: KeyQuantityIntent = { context: 'run', runId, userId: btn.user.id, keyType };
    await btn.showModal(buildKeyQuantityModal(intent, formatKeyLabel(keyType)));
}

export async function handleRunKeyQuantitySubmit(
    interaction: ModalSubmitInteraction,
    intent: Extract<KeyQuantityIntent, { context: 'run' }>
): Promise<void> {
    if (interaction.user.id !== intent.userId) {
        await interaction.reply({ content: '❌ This key quantity modal belongs to another user.', flags: MessageFlags.Ephemeral });
        return;
    }
    const quantity = parseKeyQuantity(interaction.fields.getTextInputValue(KEY_QUANTITY_INPUT_ID));
    if (quantity === null) {
        await interaction.reply({ content: '❌ Enter a whole number from 1 to 10.', flags: MessageFlags.Ephemeral });
        return;
    }
    const guildId = interaction.guildId;
    const run = guildId ? await getRunDetails(intent.runId, guildId).catch(() => null) : null;
    if (!guildId || !run || !isRunAcceptingKeyOffers(run) || !isKeyAvailableForRun(run, intent.keyType)) {
        await interaction.reply({ content: '❌ This run has ended or no longer contains that key.', flags: MessageFlags.Ephemeral });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let keyTotal = 0;
    await serializeKeyRefresh(`run:${intent.runId}`, async () => {
        const response = KeyOfferResponseSchema.parse(await postJSON<unknown>(
            `/runs/${intent.runId}/key-reactions`,
            { userId: intent.userId, keyType: intent.keyType, quantity },
            { guildId }
        ));
        keyTotal = response.keyCounts[intent.keyType] ?? 0;
        await refreshRunDisplays(intent.runId, guildId, await fetchRunMessage(interaction, run), response.keyOffers);
    });

    await logKeyReaction(interaction.client, {
        guildId,
        organizerId: run.organizerId,
        organizerUsername: '',
        dungeonName: getRunDisplayLabel(run),
        type: 'run',
        runId: Number(intent.runId),
    }, intent.userId, intent.keyType, 'added', keyTotal).catch(error => {
        console.error('Failed to log run key quantity:', error);
    });

    let confirmation = `${getEmojiDisplayForKeyType(intent.keyType) || '🗝️'} Offering **${quantity}× ${formatKeyLabel(intent.keyType)}**. Submitting again replaces this quantity.`;
    if (run.party && run.location) {
        const alreadyNotified = hasBeenNotified(intent.runId, intent.userId, run.party, run.location);
        if (!alreadyNotified) {
            const sent = await sendKeyReactorDM(
                interaction.client, intent.userId, guildId, intent.runId, getRunDisplayLabel(run),
                run.organizerId, [intent.keyType], run.party, run.location, false
            );
            if (sent) markAsNotified(intent.runId, intent.userId, run.party, run.location);
            confirmation += sent
                ? `\n\n✉️ Party and location sent by DM: **${run.party}** | **${run.location}**`
                : `\n\n⚠️ I could not DM you. Party: **${run.party}** | Location: **${run.location}**`;
        } else {
            confirmation += `\n\nParty: **${run.party}** | Location: **${run.location}**`;
        }
    } else {
        confirmation += '\n\n📬 You will receive a DM when the organizer sets the party and location.';
    }
    await interaction.editReply({ content: confirmation, components: [buildWithdrawKeyButton(intent)] });
}

export async function handleRunKeyWithdrawal(
    interaction: ButtonInteraction,
    intent: Extract<KeyQuantityIntent, { context: 'run' }>
): Promise<void> {
    if (interaction.user.id !== intent.userId) {
        await interaction.reply({ content: '❌ This withdrawal button belongs to another user.', flags: MessageFlags.Ephemeral });
        return;
    }
    await interaction.deferUpdate();
    const guildId = interaction.guildId;
    const run = guildId ? await getRunDetails(intent.runId, guildId).catch(() => null) : null;
    if (!guildId || !run || !isRunAcceptingKeyOffers(run) || !isKeyAvailableForRun(run, intent.keyType)) {
        await interaction.editReply({
            content: '❌ This run has ended or is no longer accepting changes.',
            components: [],
        });
        return;
    }
    let removed = false;
    let keyTotal = 0;
    await serializeKeyRefresh(`run:${intent.runId}`, async () => {
        const response = KeyOfferResponseSchema.parse(await deleteJSON<unknown>(
            `/runs/${intent.runId}/key-reactions`,
            { userId: intent.userId, keyType: intent.keyType },
            { guildId }
        ));
        removed = response.removed ?? false;
        keyTotal = response.keyCounts[intent.keyType] ?? 0;
        await refreshRunDisplays(intent.runId, guildId, await fetchRunMessage(interaction, run), response.keyOffers);
    });
    if (removed) {
        await logKeyReaction(interaction.client, {
            guildId,
            organizerId: run.organizerId,
            organizerUsername: '',
            dungeonName: getRunDisplayLabel(run),
            type: 'run',
            runId: Number(intent.runId),
        }, intent.userId, intent.keyType, 'removed', keyTotal).catch(() => undefined);
    }
    await interaction.editReply({
        content: removed ? '✅ Your key offer was withdrawn.' : 'ℹ️ You no longer have an offer for that key.',
        components: [],
    });
}
