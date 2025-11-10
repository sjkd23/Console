import { ButtonInteraction, EmbedBuilder } from 'discord.js';
import { postJSON } from '../../lib/http.js';

function badgeTitle(title: string, status: 'started' | 'ended'): string {
    const clean = title.replace(/\s+\[(Started|Ended)\]$/i, '');
    const tag = status === 'started' ? '[Started]' : '[Ended]';
    return `${clean} ${tag}`;
}

export async function handleStatus(btn: ButtonInteraction, runId: string, status: 'started' | 'ended') {
    await btn.deferReply({ ephemeral: true });

    await postJSON(`/runs/${runId}`, { status });

    // Update the public message title with a badge
    const embeds = btn.message.embeds ?? [];
    if (embeds.length) {
        const eb = EmbedBuilder.from(embeds[0]);
        const title = eb.data.title ?? 'Run';
        eb.setTitle(badgeTitle(title, status));
        await btn.message.edit({ embeds: [eb, ...embeds.slice(1)] });
    }

    await btn.editReply(`Run ${status === 'started' ? 'started' : 'ended'} ✔️`);
}
