import {
    ButtonInteraction,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder
} from 'discord.js';
import { isOrganizer } from '../../lib/permissions.js';

function getDungeonFromMessageTitle(title?: string | null): string {
    if (!title) return 'Raid';
    const idx = title.indexOf(' — ');
    return idx >= 0 ? title.slice(0, idx) : title;
}

export async function handleOrganizerPanel(btn: ButtonInteraction, runId: string) {
    const organizerRoleId = process.env.ORGANIZER_ROLE_ID;
    const member = btn.guild?.members.cache.get(btn.user.id) ?? await btn.guild?.members.fetch(btn.user.id).catch(() => null);

    if (!isOrganizer(member ?? null, organizerRoleId)) {
        await btn.reply({ content: 'Organizer only. If you should have access, check your role.', ephemeral: true });
        return;
    }

    const dungeon = getDungeonFromMessageTitle(btn.message.embeds?.[0]?.title);

    const embed = new EmbedBuilder()
        .setTitle(`Organizer Panel — ${dungeon}`)
        .setDescription('Use these controls to manage the raid. You can reopen this panel anytime via the Organizer Panel button.')
        .setTimestamp(new Date());

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`run:start:${runId}`).setLabel('Start').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`run:end:${runId}`).setLabel('End').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`run:panel:${runId}`).setLabel('Refresh Panel').setStyle(ButtonStyle.Secondary)
    );

    if (btn.deferred || btn.replied) {
        await btn.followUp({ embeds: [embed], components: [row], ephemeral: true });
    } else {
        await btn.reply({ embeds: [embed], components: [row], ephemeral: true });
    }
}
