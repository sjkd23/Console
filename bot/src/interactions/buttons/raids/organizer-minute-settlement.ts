import type { ButtonInteraction, ModalSubmitInteraction } from 'discord.js';
import {
    BackendError,
    cancelOrganizerMinuteSettlement,
    confirmOrganizerMinuteSettlement,
    modifyOrganizerMinuteSettlement,
    viewOrganizerMinuteSettlement,
} from '../../../lib/utilities/http.js';
import { buildMinuteModifyModal, buildMinuteSettlementMessage } from '../../../lib/ui/organizer-minute-settlement.js';
import { updateQuotaPanelForRole } from '../../../lib/ui/quota-panel.js';

async function refresh(interaction: ButtonInteraction | ModalSubmitInteraction, runId: number) {
    const current = await viewOrganizerMinuteSettlement(runId, interaction.guildId!, interaction.user.id);
    await interaction.editReply(buildMinuteSettlementMessage(current));
}

export async function handleMinuteConfirm(interaction: ButtonInteraction, runId: number, revision: number) {
    await interaction.deferUpdate();
    try {
        const settlement = await confirmOrganizerMinuteSettlement(runId, interaction.guildId!, interaction.user.id, revision);
        await interaction.editReply(buildMinuteSettlementMessage(settlement));
        await updateQuotaPanelForRole(interaction.client, interaction.guildId!, settlement.quotaRoleId);
    } catch (error) {
        if (error instanceof BackendError && (error.code === 'STALE_REVISION' || error.status === 409)) {
            await refresh(interaction, runId);
            return;
        }
        throw error;
    }
}

export async function handleMinuteModify(interaction: ButtonInteraction, runId: number, revision: number) {
    const settlement = await viewOrganizerMinuteSettlement(runId, interaction.guildId!, interaction.user.id);
    if (settlement.revision !== revision || settlement.status !== 'pending') {
        await interaction.update(buildMinuteSettlementMessage(settlement));
        return;
    }
    await interaction.showModal(buildMinuteModifyModal(runId, revision, settlement.selectedMinutes));
}

export async function handleMinuteModifySubmit(interaction: ModalSubmitInteraction, runId: number, revision: number) {
    const raw = interaction.fields.getTextInputValue('minutes').trim();
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
        await interaction.reply({ content: 'Minutes must be a positive integer.', ephemeral: true });
        return;
    }
    await interaction.deferUpdate();
    try {
        const settlement = await modifyOrganizerMinuteSettlement(runId, interaction.guildId!, interaction.user.id, revision, Number(raw));
        await interaction.editReply(buildMinuteSettlementMessage(settlement));
    } catch (error) {
        if (error instanceof BackendError && (error.code === 'STALE_REVISION' || error.status === 409)) {
            await refresh(interaction, runId);
            return;
        }
        throw error;
    }
}

export async function handleMinuteCancel(interaction: ButtonInteraction, runId: number) {
    await interaction.deferUpdate();
    try {
        const settlement = await cancelOrganizerMinuteSettlement(runId, interaction.guildId!, interaction.user.id);
        await interaction.editReply(buildMinuteSettlementMessage(settlement));
    } catch (error) {
        if (error instanceof BackendError && error.status === 409) {
            await refresh(interaction, runId);
            return;
        }
        throw error;
    }
}
