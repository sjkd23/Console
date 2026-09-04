/** Handles quantity-based key offers for active, in-memory headcounts. */

import {
    ButtonInteraction,
    EmbedBuilder,
    MessageFlags,
    ModalSubmitInteraction,
    type Message,
} from 'discord.js';
import { dungeonByCode } from '../../../constants/dungeons/dungeon-helpers.js';
import { getReactionInfo } from '../../../constants/emojis/MappedAfkCheckReactions.js';
import { logKeyReaction } from '../../../lib/logging/raid-logger.js';
import {
    getActiveHeadcountByMessageId,
    isHeadcountExpired,
} from '../../../lib/state/active-headcount-tracker.js';
import { getActiveHeadcountPanels } from '../../../lib/state/headcount-panel-tracker.js';
import {
    buildKeyQuantityModal,
    buildWithdrawKeyButton,
    getKeyOfferQuantity,
    type HeadcountKeyOfferStore,
    type KeyQuantityIntent,
    parseKeyQuantity,
    removeKeyOffer,
    serializeKeyRefresh,
    setKeyOfferQuantity,
    totalKeyQuantity,
    KEY_QUANTITY_INPUT_ID,
} from '../../../lib/utilities/key-quantity.js';
import { updateHeadcountOrganizerPanel } from './headcount-organizer-panel.js';

const keyOffersStore = new Map<string, HeadcountKeyOfferStore>();

export function getKeyOffers(messageId: string): HeadcountKeyOfferStore {
    let keyMap = keyOffersStore.get(messageId);
    if (!keyMap) {
        keyMap = new Map();
        keyOffersStore.set(messageId, keyMap);
    }
    return keyMap;
}

export function clearKeyOffers(messageId: string): void {
    keyOffersStore.delete(messageId);
}

export function formatKeyTypeForDisplay(mapKey: string): string {
    const specialCases: Record<string, string> = {
        WC_INC: 'Wine Cellar Incantation',
        SHIELD_RUNE: 'Shield Rune',
        SWORD_RUNE: 'Sword Rune',
        HELM_RUNE: 'Helm Rune',
    };
    return specialCases[mapKey]
        ?? mapKey.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, letter => letter.toUpperCase());
}

function getEmojiDisplayForKeyType(keyType: string): string {
    const reactionInfo = getReactionInfo(keyType);
    if (!reactionInfo?.emojiInfo?.identifier) return '🗝️';
    return reactionInfo.emojiInfo.isCustom
        ? `<:key:${reactionInfo.emojiInfo.identifier}>`
        : reactionInfo.emojiInfo.identifier;
}

function isValidHeadcountKey(dungeonCode: string, keyType: string): boolean {
    return dungeonByCode[dungeonCode]?.keyReactions.some(reaction => reaction.mapKey === keyType) ?? false;
}

function resolveKeyType(dungeonCode: string, mapKey?: string): string | null {
    if (mapKey && isValidHeadcountKey(dungeonCode, mapKey)) return mapKey;
    if (mapKey) return null;
    return dungeonByCode[dungeonCode]?.keyReactions[0]?.mapKey ?? null;
}

function truncateDescription(description: string): string {
    return description.length <= 4096 ? description : `${description.slice(0, 4093)}...`;
}

export function updateHeadcountKeyDisplay(
    embed: EmbedBuilder,
    keyOffers: HeadcountKeyOfferStore
): EmbedBuilder {
    const data = embed.toJSON();
    const keySectionMarker = '\u200B';
    let description = data.description ?? '';
    description = description
        .replace(/\n\n\*\*Key (?:Counts|Offers):\*\*\n[\s\S]*$/, '')
        .replace(new RegExp(`\\n\\n${keySectionMarker}[\\s\\S]*$`), '');

    const lines: string[] = [];
    for (const [dungeonCode, keyTypeMap] of keyOffers) {
        const dungeon = dungeonByCode[dungeonCode];
        const dungeonName = dungeon?.dungeonName ?? dungeonCode;
        const hasMultipleKeyTypes = (dungeon?.keyReactions.length ?? 0) > 1;
        for (const [keyType, userQuantities] of keyTypeMap) {
            if (userQuantities.size === 0) continue;
            const users = [...userQuantities].map(([userId, quantity]) => ({ userId, quantity }));
            const total = totalKeyQuantity(users);
            const label = hasMultipleKeyTypes ? formatKeyTypeForDisplay(keyType) : dungeonName;
            lines.push(`${getEmojiDisplayForKeyType(keyType)} ${label}: ${total}`);
        }
    }

    if (lines.length > 0) description += `\n\n${keySectionMarker}${lines.join('\n')}`;

    const fields = (data.fields ?? []).filter(field => field.name !== 'Total Keys' && field.name !== 'Keys');
    return new EmbedBuilder(data).setDescription(truncateDescription(description)).setFields(fields);
}

async function fetchHeadcountMessage(
    interaction: ButtonInteraction | ModalSubmitInteraction,
    messageId: string
): Promise<Message<true> | null> {
    const guild = interaction.guild;
    const activeHeadcount = guild ? getActiveHeadcountByMessageId(guild.id, messageId) : null;
    if (!guild || !activeHeadcount || isHeadcountExpired(activeHeadcount)) return null;
    const channel = await guild.channels.fetch(activeHeadcount.channelId).catch(() => null);
    if (!channel?.isTextBased()) return null;
    return channel.messages.fetch(messageId).catch(() => null);
}

async function refreshHeadcountDisplays(publicMsg: Message<true>): Promise<void> {
    const activeHeadcount = getActiveHeadcountByMessageId(publicMsg.guild.id, publicMsg.id);
    if (!activeHeadcount || publicMsg.embeds.length === 0) return;
    const updatedEmbed = updateHeadcountKeyDisplay(
        EmbedBuilder.from(publicMsg.embeds[0]),
        getKeyOffers(publicMsg.id)
    );
    await publicMsg.edit({ embeds: [updatedEmbed, ...publicMsg.embeds.slice(1)] });
    for (const handle of getActiveHeadcountPanels(publicMsg.id)) {
        await updateHeadcountOrganizerPanel(handle, publicMsg, updatedEmbed, activeHeadcount.dungeonCodes);
    }
}

export async function handleHeadcountKey(
    btn: ButtonInteraction,
    _panelTimestamp: string,
    dungeonCode: string,
    mapKey?: string
): Promise<void> {
    if (!btn.guild || btn.user.bot) {
        await btn.reply({ content: '❌ You cannot interact with this headcount.', flags: MessageFlags.Ephemeral });
        return;
    }
    const activeHeadcount = getActiveHeadcountByMessageId(btn.guild.id, btn.message.id);
    const keyType = resolveKeyType(dungeonCode, mapKey);
    if (!activeHeadcount || isHeadcountExpired(activeHeadcount)) {
        await btn.reply({ content: '❌ This headcount is closed or expired.', flags: MessageFlags.Ephemeral });
        return;
    }
    if (!activeHeadcount.dungeonCodes.includes(dungeonCode) || !keyType) {
        await btn.reply({ content: '❌ That key is not part of this headcount.', flags: MessageFlags.Ephemeral });
        return;
    }

    const intent: KeyQuantityIntent = {
        context: 'headcount', messageId: btn.message.id, userId: btn.user.id, dungeonCode, keyType,
    };
    const currentQuantity = getKeyOfferQuantity(getKeyOffers(btn.message.id), dungeonCode, keyType, btn.user.id) ?? 1;
    await btn.showModal(buildKeyQuantityModal(intent, formatKeyTypeForDisplay(keyType), currentQuantity));
}

export async function handleHeadcountKeyQuantitySubmit(
    interaction: ModalSubmitInteraction,
    intent: Extract<KeyQuantityIntent, { context: 'headcount' }>
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
    const publicMsg = await fetchHeadcountMessage(interaction, intent.messageId);
    const activeHeadcount = interaction.guild
        ? getActiveHeadcountByMessageId(interaction.guild.id, intent.messageId)
        : null;
    if (!publicMsg || !activeHeadcount || !activeHeadcount.dungeonCodes.includes(intent.dungeonCode)
        || !isValidHeadcountKey(intent.dungeonCode, intent.keyType)) {
        await interaction.reply({ content: '❌ This headcount is closed, expired, or no longer contains that key.', flags: MessageFlags.Ephemeral });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let accepted = false;
    await serializeKeyRefresh(`headcount:${intent.messageId}`, async () => {
        const latest = interaction.guild
            ? getActiveHeadcountByMessageId(interaction.guild.id, intent.messageId)
            : null;
        if (!latest || isHeadcountExpired(latest) || !latest.dungeonCodes.includes(intent.dungeonCode)) return;
        accepted = true;
        setKeyOfferQuantity(getKeyOffers(intent.messageId), intent.dungeonCode, intent.keyType, intent.userId, quantity);
        await refreshHeadcountDisplays(publicMsg);
    });
    if (!accepted) {
        await interaction.editReply('❌ This headcount closed before the offer could be saved.');
        return;
    }

    const currentOffers = getKeyOffers(intent.messageId).get(intent.dungeonCode)?.get(intent.keyType) ?? new Map();
    const keyTotal = totalKeyQuantity([...currentOffers].map(([userId, amount]) => ({ userId, quantity: amount })));
    await logKeyReaction(interaction.client, {
        guildId: activeHeadcount.guildId,
        organizerId: activeHeadcount.organizerId,
        organizerUsername: '',
        dungeonName: dungeonByCode[intent.dungeonCode]?.dungeonName ?? intent.dungeonCode,
        type: 'headcount',
        panelTimestamp: intent.messageId,
    }, intent.userId, formatKeyTypeForDisplay(intent.keyType), 'added', keyTotal).catch(error => {
        console.error('Failed to log headcount key quantity:', error);
    });

    await interaction.editReply({
        content: `✅ Offering **${quantity}× ${formatKeyTypeForDisplay(intent.keyType)}**. Submitting again replaces this quantity.`,
        components: [buildWithdrawKeyButton(intent)],
    });
}

export async function handleHeadcountKeyWithdrawal(
    interaction: ButtonInteraction,
    intent: Extract<KeyQuantityIntent, { context: 'headcount' }>
): Promise<void> {
    if (interaction.user.id !== intent.userId) {
        await interaction.reply({ content: '❌ This withdrawal button belongs to another user.', flags: MessageFlags.Ephemeral });
        return;
    }
    await interaction.deferUpdate();
    const publicMsg = await fetchHeadcountMessage(interaction, intent.messageId);
    if (!publicMsg || !isValidHeadcountKey(intent.dungeonCode, intent.keyType)) {
        await interaction.editReply({ content: '❌ This headcount is closed or expired.', components: [] });
        return;
    }
    let removed = false;
    let accepted = false;
    await serializeKeyRefresh(`headcount:${intent.messageId}`, async () => {
        const latest = interaction.guild
            ? getActiveHeadcountByMessageId(interaction.guild.id, intent.messageId)
            : null;
        if (!latest || isHeadcountExpired(latest) || !latest.dungeonCodes.includes(intent.dungeonCode)) return;
        accepted = true;
        removed = removeKeyOffer(getKeyOffers(intent.messageId), intent.dungeonCode, intent.keyType, intent.userId);
        await refreshHeadcountDisplays(publicMsg);
    });
    if (!accepted) {
        await interaction.editReply({
            content: '❌ This headcount closed before the offer could be withdrawn.',
            components: [],
        });
        return;
    }
    if (removed) {
        const activeHeadcount = interaction.guild
            ? getActiveHeadcountByMessageId(interaction.guild.id, intent.messageId)
            : null;
        if (activeHeadcount) {
            const currentOffers = getKeyOffers(intent.messageId).get(intent.dungeonCode)?.get(intent.keyType) ?? new Map();
            const total = totalKeyQuantity([...currentOffers].map(([userId, quantity]) => ({ userId, quantity })));
            await logKeyReaction(interaction.client, {
                guildId: activeHeadcount.guildId,
                organizerId: activeHeadcount.organizerId,
                organizerUsername: '',
                dungeonName: dungeonByCode[intent.dungeonCode]?.dungeonName ?? intent.dungeonCode,
                type: 'headcount',
                panelTimestamp: intent.messageId,
            }, intent.userId, formatKeyTypeForDisplay(intent.keyType), 'removed', total).catch(() => undefined);
        }
    }
    await interaction.editReply({
        content: removed ? '✅ Your key offer was withdrawn.' : 'ℹ️ You no longer have an offer for that key.',
        components: [],
    });
}
