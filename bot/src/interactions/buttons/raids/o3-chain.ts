import {
    ButtonInteraction,
    ChannelType,
    EmbedBuilder,
    MessageFlags,
    type GuildTextBasedChannel,
} from 'discord.js';
import {
    BackendError,
    chainOryx3Run,
    deleteJSON,
    getRunDetails,
} from '../../../lib/utilities/http.js';
import { checkOrganizerAccess } from '../../../lib/permissions/interaction-permissions.js';
import { getMemberRoleIds } from '../../../lib/permissions/permissions.js';
import { createRunRole, deleteRunRole } from '../../../lib/utilities/run-role-manager.js';
import { getRunLockKey, withButtonLock } from '../../../lib/utilities/button-mutex.js';
import { checkOrganizerActiveActivities } from '../../../lib/utilities/organizer-activity-checker.js';
import { initializePublishedRun, publishCreatedRun } from '../../../lib/utilities/run-publication.js';
import { sendRunOrganizerPanelAsFollowUp } from './organizer-panel.js';
import { createLogger } from '../../../lib/logging/logger.js';

const logger = createLogger('O3Chain');

export async function handleStartNewO3(btn: ButtonInteraction, previousRunId: string): Promise<void> {
    await btn.deferUpdate();
    await withButtonLock(btn, getRunLockKey('chain-o3', previousRunId), async () => {
        await handleStartNewO3Internal(btn, previousRunId);
    });
}

async function handleStartNewO3Internal(btn: ButtonInteraction, previousRunId: string): Promise<void> {
    if (!btn.guild || !btn.guildId) {
        await btn.editReply({ content: 'This action can only be used in a server.', embeds: [], components: [] });
        return;
    }
    const previousRun = await getRunDetails(previousRunId, btn.guildId).catch(() => null);
    if (!previousRun) {
        await btn.editReply({ content: 'The previous run could not be found.', embeds: [], components: [] });
        return;
    }
    if (previousRun.runKind !== 'oryx_3') {
        await btn.editReply({ content: 'Only completed Oryx 3 runs can use this action.', embeds: [], components: [] });
        return;
    }
    if (previousRun.status !== 'ended' || previousRun.finalizationKind !== 'completed') {
        await btn.editReply({
            content: 'The previous Oryx 3 has not completed its normal finalization.',
            embeds: [],
            components: [],
        });
        return;
    }
    const access = await checkOrganizerAccess(btn, previousRun.organizerId);
    if (!access.allowed) {
        await btn.editReply({ content: access.errorMessage, embeds: [], components: [] });
        return;
    }

    const actorMember = await btn.guild.members.fetch(btn.user.id).catch(() => null);
    const organizerMember = await btn.guild.members.fetch(previousRun.organizerId).catch(() => null);
    if (!actorMember || !organizerMember) {
        await btn.editReply({
            content: 'Could not fetch the organizer information needed to start the next O3.',
            embeds: [],
            components: [],
        });
        return;
    }
    const activity = await checkOrganizerActiveActivities(btn, btn.guildId, previousRun.organizerId, {
        failClosedOnRunCheckError: true,
        blockOnAnyActiveRunRecord: true,
    });
    if (activity.errorMessage) {
        await btn.editReply({ content: activity.errorMessage, embeds: [], components: [] });
        return;
    }

    const role = await createRunRole(btn.guild, organizerMember.user.username, 'Oryx 3');
    let newRunId: number | null = null;
    let published = false;
    try {
        const created = await chainOryx3Run(previousRunId, {
            actorId: btn.user.id,
            actorRoles: getMemberRoleIds(actorMember),
            guildId: btn.guildId,
            guildName: btn.guild.name,
            organizerUsername: organizerMember.user.username,
            roleId: role?.id,
        });
        newRunId = created.runId;

        const newRun = await getRunDetails(created.runId, btn.guildId);
        const channel = await btn.client.channels.fetch(newRun.channelId ?? '').catch(() => null);
        if (!channel || channel.type !== ChannelType.GuildText) {
            throw new Error('The configured raid channel is no longer available.');
        }
        const message = await publishCreatedRun({
            guild: btn.guild,
            raidChannel: channel as GuildTextBasedChannel,
            organizerId: previousRun.organizerId,
            created,
            description: newRun.description ?? undefined,
            party: newRun.party ?? undefined,
            location: newRun.location ?? undefined,
        });
        published = true;

        initializePublishedRun({
            client: btn.client,
            guild: btn.guild,
            message,
            created,
            organizerId: previousRun.organizerId,
            organizerUsername: organizerMember.user.username,
            roleId: role?.id,
            description: newRun.description ?? undefined,
            party: newRun.party ?? undefined,
            location: newRun.location ?? undefined,
        });

        const successEmbed = new EmbedBuilder()
            .setTitle('✅ New Oryx 3 Created')
            .setDescription(`The previous O3 remains ended. [Open the new O3 panel](${message.url})`)
            .setColor(0x00ff00)
            .setTimestamp();
        await btn.editReply({ content: '', embeds: [successEmbed], components: [] });
        await sendRunOrganizerPanelAsFollowUp(btn, created.runId, btn.guildId);
    } catch (error) {
        if (error instanceof BackendError && error.code === 'O3_ALREADY_CHAINED') {
            if (role) await deleteRunRole(btn.guild, role.id);
            await btn.editReply({
                content: 'A new Oryx 3 has already been created from this completed run.',
                embeds: [],
                components: [],
            });
            return;
        }
        if (newRunId !== null && !published) {
            await deleteJSON(`/runs/${newRunId}`, {
                actorId: btn.user.id,
                actorRoles: getMemberRoleIds(actorMember),
            }, { guildId: btn.guildId }).catch(rollbackError => logger.error(
                'Failed to cancel an unpublished chained O3',
                { newRunId, rollbackError }
            ));
        }
        if (role && !published) await deleteRunRole(btn.guild, role.id);
        logger.error('Failed to create chained O3', { previousRunId, error });
        await btn.editReply({
            content: error instanceof Error ? `Failed to start the new O3: ${error.message}` : 'Failed to start the new O3.',
            embeds: [],
            components: [],
        });
    }
}

export async function handleFinishO3Chain(btn: ButtonInteraction): Promise<void> {
    await btn.update({
        content: '',
        embeds: [new EmbedBuilder()
            .setTitle('✅ Oryx 3 Ended')
            .setDescription('The run is fully ended and this panel is now closed.')
            .setColor(0x00ff00)
            .setTimestamp()],
        components: [],
    }).catch(async () => {
        if (!btn.replied && !btn.deferred) {
            await btn.reply({ content: 'This panel is now closed.', flags: MessageFlags.Ephemeral });
        }
    });
}
