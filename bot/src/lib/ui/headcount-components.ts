import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} from 'discord.js';
import type { DungeonInfo } from '../../constants/dungeons/dungeon-types.js';
import { dungeonByCode } from '../../constants/dungeons/dungeon-helpers.js';
import { getReactionInfo } from '../../constants/emojis/MappedAfkCheckReactions.js';
import { getPhysicalDungeonKeyOffers } from '../utilities/dungeon-key-offers.js';

const BUTTONS_PER_ROW = 5;
const MAX_ACTION_ROWS = 5;
const MAX_BUTTON_LABEL_LENGTH = 80;

export function buildHeadcountInterestSummary(
    dungeonCodes: readonly string[],
    interestsByDungeon: ReadonlyMap<string, ReadonlySet<string>>
): string {
    if (dungeonCodes.length === 0) return '_No dungeons found_';

    return dungeonCodes.map(dungeonCode => {
        const dungeonName = dungeonByCode[dungeonCode]?.dungeonName || dungeonCode;
        const interestedUsers = interestsByDungeon.get(dungeonCode) ?? new Set<string>();
        return `${dungeonName}: **${interestedUsers.size}**`;
    }).join('\n');
}

function truncateButtonLabel(label: string, maxLength = MAX_BUTTON_LABEL_LENGTH): string {
    return label.length <= maxLength ? label : `${label.slice(0, maxLength - 3)}...`;
}

function formatKeyButtonLabel(mapKey: string): string {
    const specialCases: Record<string, string> = {
        WC_INC: 'Inc',
        SHIELD_RUNE: 'Shield',
        SWORD_RUNE: 'Sword',
        HELM_RUNE: 'Helm',
    };
    return specialCases[mapKey] || 'Key';
}

function getKeyReactionEmojiIdentifier(mapKey: string): string | undefined {
    return getReactionInfo(mapKey)?.emojiInfo?.identifier;
}

function chunkButtons(buttons: readonly ButtonBuilder[]): ButtonBuilder[][] {
    const chunks: ButtonBuilder[][] = [];
    for (let index = 0; index < buttons.length; index += BUTTONS_PER_ROW) {
        chunks.push(buttons.slice(index, index + BUTTONS_PER_ROW));
    }
    return chunks;
}

/**
 * Build public headcount controls from one ordered dungeon list.
 * Headcounts currently allow at most five dungeons, so the interest buttons always
 * occupy one row and every ordered key row follows immediately beneath it.
 */
export function buildHeadcountActionRows(
    selectedDungeons: readonly DungeonInfo[],
    panelToken: string
): ActionRowBuilder<ButtonBuilder>[] {
    if (selectedDungeons.length < 1 || selectedDungeons.length > BUTTONS_PER_ROW) {
        throw new Error('Headcount controls require between 1 and 5 dungeons.');
    }

    const interestButtons = selectedDungeons.map(dungeon => new ButtonBuilder()
        .setCustomId(`headcount:interest:${panelToken}:${dungeon.codeName}`)
        .setLabel(truncateButtonLabel(dungeon.dungeonName))
        .setStyle(ButtonStyle.Success));

    const isSingleDungeon = selectedDungeons.length === 1;
    const keyButtons = getPhysicalDungeonKeyOffers(selectedDungeons).map(({ dungeon, reaction }) => {
        const label = isSingleDungeon || dungeon.keyReactions.length > 1
            ? formatKeyButtonLabel(reaction.mapKey)
            : truncateButtonLabel(dungeon.dungeonName, 15);
        const keyButton = new ButtonBuilder()
            .setCustomId(`headcount:key:${panelToken}:${dungeon.codeName}:${reaction.mapKey}`)
            .setLabel(label)
            .setStyle(ButtonStyle.Secondary);
        const emojiIdentifier = getKeyReactionEmojiIdentifier(reaction.mapKey);
        if (emojiIdentifier) keyButton.setEmoji(emojiIdentifier);
        return keyButton;
    });

    const rows = [new ActionRowBuilder<ButtonBuilder>().addComponents(...interestButtons)];
    for (const keyChunk of chunkButtons(keyButtons)) {
        rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...keyChunk));
    }

    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`headcount:org:${panelToken}`)
            .setLabel('Organizer Panel')
            .setStyle(ButtonStyle.Secondary)
    ));

    if (rows.length > MAX_ACTION_ROWS) {
        throw new Error('Headcount controls exceed Discord\'s five-row component limit.');
    }

    return rows;
}
