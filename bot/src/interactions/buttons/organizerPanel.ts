import {
    ButtonInteraction,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder
} from 'discord.js';
import { isOrganizer } from '../../lib/permissions.js';

export async function handleOrganizerPanel(btn: ButtonInteraction, runId: string) {
    const organizerRoleId = process.env.ORGANIZER_ROLE_ID;
    const member = btn.guild?.members.cache.get(btn.user.id) ?? await btn.guild?.members.fetch(btn.user.id).catch(() => null);

    if (!isOrganizer(member ?? null, organizerRoleId)) {
        return btn.reply({ content: 'Organizer only. If you should have access, check your role.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
        .setTitle(`Organizer Panel — Run #${runId}`)
        .setDescription('These actions are visible only to you. Dismiss and re-open via the Organizer Panel button anytime.')
        .setTimestamp(new Date());

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`run:start:${runId}`).setLabel('Start').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`run:end:${runId}`).setLabel('End').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`run:cancel:${runId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    );

    // If they already have an ephemeral response thread, followUp works; otherwise reply.
    if (btn.deferred || btn.replied) {
        return btn.followUp({ embeds: [embed], components: [row], ephemeral: true });
    } else {
        return btn.reply({ embeds: [embed], components: [row], ephemeral: true });
    }
}
