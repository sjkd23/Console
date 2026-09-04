/** Handles dungeon-specific interest buttons for active headcount panels. */

import { ButtonInteraction, EmbedBuilder, MessageFlags } from 'discord.js';
import { dungeonByCode } from '../../../constants/dungeons/dungeon-helpers.js';
import { logRaidJoin } from '../../../lib/logging/raid-logger.js';
import {
    getActiveHeadcountByMessageId,
} from '../../../lib/state/active-headcount-tracker.js';
import { getActiveHeadcountPanels } from '../../../lib/state/headcount-panel-tracker.js';
import { toggleDungeonInterest } from '../../../lib/state/headcount-state.js';
import { getHeadcountInterestRejection } from '../../../lib/utilities/headcount-interest-validation.js';
import { updateHeadcountOrganizerPanel } from './headcount-organizer-panel.js';

export async function handleHeadcountInterest(
    btn: ButtonInteraction,
    panelTimestamp: string,
    dungeonCode: string
): Promise<void> {
    await btn.deferReply({ flags: MessageFlags.Ephemeral });

    if (!btn.guild || btn.user.bot) {
        await btn.editReply('❌ You cannot interact with this headcount.');
        return;
    }

    const publicMsg = btn.message;
    if (publicMsg.embeds.length === 0) {
        await btn.editReply('❌ Headcount panel not found.');
        return;
    }

    const activeHeadcount = getActiveHeadcountByMessageId(btn.guild.id, publicMsg.id);
    const rejection = getHeadcountInterestRejection(activeHeadcount, dungeonCode);
    if (rejection || !activeHeadcount) {
        await btn.editReply(rejection ?? '❌ This headcount is closed or expired.');
        return;
    }

    const dungeon = dungeonByCode[dungeonCode];
    if (!dungeon) {
        await btn.editReply('❌ That dungeon is not part of this headcount.');
        return;
    }

    const result = toggleDungeonInterest(publicMsg.id, dungeonCode, btn.user.id);
    const response = result.interested
        ? `✅ **Interested in ${dungeon.dungeonName}.** Click again to remove.`
        : `✅ **No longer interested in ${dungeon.dungeonName}.**`;

    try {
        await logRaidJoin(
            btn.client,
            {
                guildId: btn.guild.id,
                organizerId: activeHeadcount.organizerId,
                organizerUsername: '',
                dungeonName: dungeon.dungeonName,
                type: 'headcount',
                panelTimestamp,
            },
            btn.user.id,
            result.interested ? 'joined' : 'left',
            result.count
        );
    } catch (error) {
        console.error('Failed to log headcount interest to raid-log:', error);
    }

    const embed = EmbedBuilder.from(publicMsg.embeds[0]);
    for (const handle of getActiveHeadcountPanels(publicMsg.id)) {
        await updateHeadcountOrganizerPanel(
            handle,
            publicMsg,
            embed,
            activeHeadcount.dungeonCodes
        );
    }

    await btn.editReply(response);
}
