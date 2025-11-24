import { ButtonInteraction, EmbedBuilder, MessageFlags } from 'discord.js';
import { postJSON, getJSON } from '../../../lib/utilities/http.js';
import { logRaidJoin } from '../../../lib/logging/raid-logger.js';
import { assignRunRole } from '../../../lib/utilities/run-role-manager.js';
import { updateRunParticipation } from '../../../lib/utilities/run-embed-helpers.js';

export async function handleJoin(btn: ButtonInteraction, runId: string) {
    // Defer the reply so we can send a follow-up message
    await btn.deferReply({ flags: MessageFlags.Ephemeral });

    const guildId = btn.guildId;
    if (!guildId) {
        await btn.editReply({ content: '❌ This command can only be used in a server.' });
        return;
    }

    // Fetch run details for logging and role assignment
    const run = await getJSON<{ 
        dungeonKey: string; 
        dungeonLabel: string; 
        organizerId: string;
        roleId: string | null;
        status: string;
    }>(`/runs/${runId}`, { guildId }).catch(() => null);

    if (!run) {
        await btn.editReply({ content: '❌ Run not found.' });
        return;
    }

    // Check if run is still joinable
    if (run.status === 'ended' || run.status === 'cancelled') {
        await btn.editReply({ content: '❌ **This run has ended.**' });
        return;
    }

    // Check if user is already in the run
    const existingReaction = await getJSON<{ state: string | null }>(
        `/runs/${runId}/reactions/${btn.user.id}`,
        { guildId }
    ).catch(() => ({ state: null }));

    if (existingReaction.state === 'join') {
        await btn.editReply({
            content: '✅ **Already joined!** Click Leave to drop out.'
        });
        return;
    }

    // Add user to the run
    const result = await postJSON<{ joinCount: number; joined: boolean }>(`/runs/${runId}/reactions`, {
        userId: btn.user.id,
        state: 'join'
    }, { guildId });

    // Assign the run role
    if (run.roleId && btn.guild) {
        const member = await btn.guild.members.fetch(btn.user.id).catch(() => null);
        if (member) {
            await assignRunRole(member, run.roleId);
        }
    }

    // Fetch class counts to update the display
    const classRes = await getJSON<{ classCounts: Record<string, number> }>(
        `/runs/${runId}/classes`,
        { guildId }
    ).catch(() => ({ classCounts: {} }));

    // Update the embed
    const msg = btn.message;
    const embeds = msg.embeds ?? [];
    if (embeds.length > 0) {
        const first = EmbedBuilder.from(embeds[0]);
        const updated = updateRunParticipation(first, result.joinCount, classRes.classCounts);
        await msg.edit({ embeds: [updated, ...embeds.slice(1)] });
    }

    // Log to raid-log thread
    if (btn.guild) {
        try {
            await logRaidJoin(
                btn.client,
                {
                    guildId: btn.guild.id,
                    organizerId: run.organizerId,
                    organizerUsername: '', // Not needed for log lookup
                    dungeonName: run.dungeonLabel,
                    type: 'run',
                    runId: parseInt(runId)
                },
                btn.user.id,
                'joined',
                result.joinCount
            );
        } catch (e) {
            console.error('Failed to log join to raid-log:', e);
        }
    }

    // Send ephemeral confirmation message
    await btn.editReply({
        content: '✅ **Raid joined!** Click Leave to drop out.'
    });
}
