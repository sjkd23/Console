import {
    type ButtonInteraction,
    ChannelType,
    EmbedBuilder,
    MessageFlags,
    type Message,
} from 'discord.js';
import { clearHeadcountState, getDungeonCodes, getOrganizerId } from '../../../lib/state/headcount-state.js';
import { clearKeyOffers, getKeyOffers } from './headcount-key.js';
import { dungeonByCode } from '../../../constants/dungeons/dungeon-helpers.js';
import type { DungeonInfo } from '../../../constants/dungeons/dungeon-types.js';
import { classifyRunDungeons, type RunKind } from '../../../constants/dungeons/dungeon-taxonomy.js';
import { createRun, deleteJSON, postJSON } from '../../../lib/utilities/http.js';
import { getMemberRoleIds, hasRequiredRoleOrHigher } from '../../../lib/permissions/permissions.js';
import { fetchGuildMember } from '../../../lib/utilities/interaction-helpers.js';
import { logRaidCreation } from '../../../lib/logging/raid-logger.js';
import { checkOrganizerAccess } from '../../../lib/permissions/interaction-permissions.js';
import { getHeadcountLockKey, withButtonLock } from '../../../lib/utilities/button-mutex.js';
import { getDefaultAutoEndMinutes } from '../../../config/raid-config.js';
import {
    getActiveHeadcount,
    unregisterHeadcount,
    unregisterHeadcountByMessageId,
} from '../../../lib/state/active-headcount-tracker.js';
import { clearHeadcountPanels } from '../../../lib/state/headcount-panel-tracker.js';
import { registerOrganizerPanel } from '../../../lib/state/organizer-panel-tracker.js';
import { createRunRole, deleteRunRole } from '../../../lib/utilities/run-role-manager.js';
import { createLogger } from '../../../lib/logging/logger.js';
import { buildRunOrganizerPanelContent } from './organizer-panel.js';
import { updateRunKeysField } from './key-reaction.js';
import type { KeyOffersByType } from '../../../lib/utilities/key-quantity.js';
import { buildRunButtons, buildRunEmbed } from '../../../lib/utilities/run-panel-builder.js';
import { autoJoinOrganizerToRun } from '../../../lib/utilities/auto-join-helpers.js';
import { resolveDungeonRolePingIds } from '../../../lib/utilities/dungeon-role-pings.js';
import { buildRunMessageContent } from '../../../lib/utilities/run-message-helpers.js';
import { checkOrganizerActiveActivities } from '../../../lib/utilities/organizer-activity-checker.js';
import { collectHeadcountRunSubset } from '../../../lib/ui/headcount-conversion-selector.js';
import {
    collectSelectedDungeonKeyOffers,
    getHeadcountConversionMode,
    getConversionOrganizerUsername,
    retireConvertedHeadcountMessage,
    validateHeadcountConversionFreshness,
} from '../../../lib/utilities/headcount-conversion.js';

const logger = createLogger('HeadcountConvert');

export async function handleHeadcountConvert(btn: ButtonInteraction, publicMessageId: string): Promise<void> {
    await withButtonLock(btn, getHeadcountLockKey('convert', publicMessageId), async () => {
        await handleHeadcountConvertInternal(btn, publicMessageId);
    }, { holdUntilSettled: true });
}

async function handleHeadcountConvertInternal(btn: ButtonInteraction, publicMessageId: string): Promise<void> {
    if (!btn.channel || btn.channel.type !== ChannelType.GuildText || !btn.guild) {
        await btn.reply({ content: 'Could not locate headcount channel.', flags: MessageFlags.Ephemeral });
        return;
    }

    const publicMsg = await btn.channel.messages.fetch(publicMessageId).catch(() => null);
    if (!publicMsg) {
        const result = unregisterHeadcountByMessageId(btn.guild.id, publicMessageId);
        clearKeyOffers(publicMessageId);
        clearHeadcountState(publicMessageId);
        clearHeadcountPanels(publicMessageId);
        logger.warn('Headcount public message missing during convert; cleaned local state', { result, publicMessageId });
        await btn.reply({ content: 'Could not find headcount panel message.', flags: MessageFlags.Ephemeral });
        return;
    }
    if (publicMsg.embeds.length === 0) {
        await btn.reply({ content: 'Could not find headcount panel.', flags: MessageFlags.Ephemeral });
        return;
    }

    const embed = EmbedBuilder.from(publicMsg.embeds[0]);
    const organizerId = getOrganizerId(embed);
    if (!organizerId) {
        await btn.reply({ content: 'Could not determine the headcount organizer.', flags: MessageFlags.Ephemeral });
        return;
    }
    const access = await checkOrganizerAccess(btn, organizerId);
    if (!access.allowed) {
        await btn.reply({ content: access.errorMessage, flags: MessageFlags.Ephemeral });
        return;
    }

    const storedCodes = getDungeonCodes(embed, publicMsg.id);
    const dungeonCodes = storedCodes.length > 0 ? storedCodes : extractLegacyDungeonCodes(publicMsg);
    const availableDungeons = dungeonCodes
        .map(code => dungeonByCode[code])
        .filter((dungeon): dungeon is DungeonInfo => dungeon !== undefined);
    if (availableDungeons.length === 0) {
        await btn.reply({ content: 'No stored dungeon selections were found for this headcount.', flags: MessageFlags.Ephemeral });
        return;
    }

    let selectedDungeons: DungeonInfo[];
    if (getHeadcountConversionMode(availableDungeons) === 'direct') {
        selectedDungeons = availableDungeons;
        classifyRunDungeons(selectedDungeons);
        await btn.deferUpdate();
    } else {
        const subset = await collectHeadcountRunSubset(btn, publicMsg.id, availableDungeons);
        if (!subset) return;
        selectedDungeons = subset.dungeons;
        btn = subset.interaction;
    }

    await convertHeadcountToRun(btn, publicMsg, availableDungeons, selectedDungeons, organizerId);
}

function extractLegacyDungeonCodes(publicMsg: Message<true>): string[] {
    const codes: string[] = [];
    for (const row of publicMsg.components) {
        if (!('components' in row)) continue;
        for (const component of row.components) {
            if ('customId' in component && component.customId?.startsWith('headcount:key:')) {
                const code = component.customId.split(':')[3];
                if (code && !codes.includes(code)) codes.push(code);
            }
        }
    }
    return codes;
}

function getRoleLabel(runKind: RunKind, dungeons: readonly DungeonInfo[]): string {
    if (runKind === 'multi_exalt') return 'Multi Exalt';
    if (runKind === 'multi_non_exalt') return 'Multi Dungeon';
    if (runKind === 'realm_clearing') return 'Realm Clearing';
    return dungeons[0].dungeonName;
}

async function convertHeadcountToRun(
    interaction: ButtonInteraction,
    publicMsg: Message<true>,
    availableDungeons: DungeonInfo[],
    selectedDungeons: DungeonInfo[],
    organizerId: string
): Promise<void> {
    const guild = interaction.guild;
    if (!guild) return;

    const currentPublicMsg = await publicMsg.channel.messages.fetch({
        message: publicMsg.id,
        force: true,
    }).catch(() => null);
    const currentEmbed = currentPublicMsg?.embeds[0]
        ? EmbedBuilder.from(currentPublicMsg.embeds[0])
        : null;
    if (!currentPublicMsg || !currentEmbed || getOrganizerId(currentEmbed) !== organizerId) {
        await interaction.editReply({
            content: 'This headcount is no longer current. Reopen the organizer panel before converting.',
            embeds: [],
            components: [],
        });
        return;
    }

    const access = await checkOrganizerAccess(interaction, organizerId);
    if (!access.allowed) {
        await interaction.editReply({ content: access.errorMessage, embeds: [], components: [] });
        return;
    }

    const member = await fetchGuildMember(guild, organizerId);
    const organizerRole = await hasRequiredRoleOrHigher(member, 'organizer');
    if (!member || !organizerRole.hasRole) {
        await interaction.editReply({
            content: 'The original organizer is no longer eligible to create a run.',
            embeds: [],
            components: [],
        });
        return;
    }

    const organizerUsername = getConversionOrganizerUsername(organizerId, member);
    const classification = classifyRunDungeons(selectedDungeons);
    const role = await createRunRole(guild, organizerUsername, getRoleLabel(classification.runKind, selectedDungeons));
    const guildId = guild.id;

    // This is deliberately the last asynchronous validation before POST /runs.
    const activityCheck = await checkOrganizerActiveActivities(interaction, guildId, organizerId, {
        allowedHeadcountMessageId: publicMsg.id,
        failClosedOnRunCheckError: true,
        blockOnAnyActiveRunRecord: true,
    });
    const originalDungeonCodes = availableDungeons.map(dungeon => dungeon.codeName);
    const selectedDungeonCodes = selectedDungeons.map(dungeon => dungeon.codeName);
    const freshnessError = validateHeadcountConversionFreshness({
        expectedMessageId: publicMsg.id,
        expectedChannelId: publicMsg.channelId,
        activeHeadcount: getActiveHeadcount(guild.id, organizerId),
        originalDungeonCodes,
        selectedDungeonCodes,
        hasActiveRun: activityCheck.hasActiveRun,
    }, availableDungeons);
    if (freshnessError || activityCheck.hasActiveHeadcount) {
        if (role) await deleteRunRole(guild, role.id);
        await interaction.editReply({
            content: activityCheck.errorMessage ?? freshnessError ?? 'This conversion is no longer valid.',
            embeds: [],
            components: [],
        });
        return;
    }

    let backendRunId: number | null = null;
    let published = false;
    try {
        const created = await createRun({
            guildId,
            guildName: guild.name,
            organizerId,
            organizerUsername,
            organizerRoles: getMemberRoleIds(member),
            channelId: publicMsg.channelId,
            selectedDungeonKeys: selectedDungeons.map(dungeon => dungeon.codeName),
            autoEndMinutes: getDefaultAutoEndMinutes(),
            roleId: role?.id,
        });
        backendRunId = created.runId;

        const keyOffers = getKeyOffers(publicMsg.id);
        const transferredOffers = collectSelectedDungeonKeyOffers(
            keyOffers,
            selectedDungeons.map(dungeon => dungeon.codeName)
        );
        if (transferredOffers.length > 0) {
            await postJSON(`/runs/${created.runId}/keys/bulk`, {
                keys: transferredOffers,
                source: 'headcount',
            }, { guildId });
        }

        const presentationDungeons = created.selectedDungeons.map(selection => {
            const dungeon = dungeonByCode[selection.dungeonKey];
            return dungeon ? { ...dungeon, dungeonName: selection.dungeonLabel } : undefined;
        });
        if (presentationDungeons.some(dungeon => dungeon === undefined)) throw new Error('Missing bot dungeon metadata.');
        const dungeons = presentationDungeons as DungeonInfo[];
        const rolePingIds = await resolveDungeonRolePingIds(guild, created.selectedDungeons.map(dungeon => dungeon.dungeonKey));
        if (role) rolePingIds.push(role.id);
        const channel = guild.channels.cache.get(publicMsg.channelId);
        if (!channel?.isTextBased()) throw new Error('Could not find channel to post run panel.');
        const transferredByType: KeyOffersByType = {};
        for (const offer of transferredOffers) {
            (transferredByType[offer.keyType] ??= []).push({ userId: offer.userId, quantity: offer.quantity });
        }
        const runEmbed = updateRunKeysField(
            buildRunEmbed({ dungeonData: dungeons, runKind: created.runKind, organizerId, status: 'starting' }),
            transferredByType
        );
        const newRunMessage = await channel.send({
            content: buildRunMessageContent({
                selectedDungeons: created.selectedDungeons,
                additionalPingRoleIds: rolePingIds,
            }),
            embeds: [runEmbed],
            components: buildRunButtons({ runId: created.runId, dungeonData: dungeons, runKind: created.runKind }),
        });
        try {
            await postJSON(`/runs/${created.runId}/message`, { postMessageId: newRunMessage.id }, { guildId });
        } catch (error) {
            await newRunMessage.delete().catch(() => undefined);
            throw error;
        }
        published = true;

        const retirement = await retireConvertedHeadcountMessage(currentPublicMsg);
        if (retirement === 'still_active') {
            logger.error('Replacement run posted but old headcount could not be deleted or disabled', {
                publicMessageId: publicMsg.id,
                runId: created.runId,
            });
        } else {
            clearKeyOffers(publicMsg.id);
            clearHeadcountState(publicMsg.id);
            clearHeadcountPanels(publicMsg.id);
            unregisterHeadcount(guildId, organizerId);
        }

        const displayLabel = created.selectedDungeons.map(dungeon => dungeon.dungeonLabel).join(' | ');
        await logRaidCreation(interaction.client, {
            guildId, organizerId, organizerUsername,
            dungeonName: displayLabel, type: 'run', runId: created.runId,
        }, { description: 'Converted from headcount panel' }).catch(error => logger.warn('Failed to log conversion', { error }));

        const successEmbed = new EmbedBuilder()
            .setTitle('✅ Headcount Converted!')
            .setDescription(`[Jump to Raid Panel](${newRunMessage.url})`)
            .setColor(0x00FF00)
            .setTimestamp();
        await interaction.editReply({ content: '', embeds: [successEmbed], components: [] });

        const panelContent = await buildRunOrganizerPanelContent(created.runId, guildId);
        if (panelContent) {
            const panelMessage = await interaction.followUp({
                embeds: panelContent.embeds,
                components: panelContent.components,
                flags: MessageFlags.Ephemeral,
                fetchReply: true,
            });
            registerOrganizerPanel(created.runId.toString(), interaction.user.id, {
                type: 'followup', webhook: interaction.webhook, messageId: panelMessage.id,
            });
        }

        autoJoinOrganizerToRun(
            interaction.client, guild, newRunMessage, created.runId, organizerId,
            organizerUsername, created.dungeonKey, displayLabel, role?.id || null
        ).catch(error => logger.error('Failed to auto-join organizer to converted run', { error, runId: created.runId }));
    } catch (error) {
        if (backendRunId !== null && !published) {
            await deleteJSON(`/runs/${backendRunId}`, {
                actorId: organizerId,
                actorRoles: getMemberRoleIds(member),
            }, { guildId }).catch(rollbackError => {
                logger.error('Failed to cancel an unpublished converted run during rollback', {
                    runId: backendRunId,
                    rollbackError,
                });
            });
        }
        if (role && !published) await deleteRunRole(guild, role.id);
        throw error;
    }
}
