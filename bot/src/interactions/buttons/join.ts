import { ButtonInteraction, EmbedBuilder } from 'discord.js';
import { postJSON } from '../../lib/http.js';

function setRaidersField(embed: EmbedBuilder, count: number): EmbedBuilder {
    const data = embed.toJSON();
    const fields = (data.fields ?? []).map(f =>
        f.name.toLowerCase() === 'raiders' ? { ...f, value: String(count) } : f
    );
    // if not present, add it
    const hasRaiders = fields.some(f => f.name.toLowerCase() === 'raiders');
    if (!hasRaiders) fields.push({ name: 'Raiders', value: String(count), inline: true });

    const rebuilt = new EmbedBuilder(data).setFields(fields as any);
    return rebuilt;
}

export async function handleJoin(btn: ButtonInteraction, runId: string) {
    await btn.deferUpdate(); // acknowledge button; we’ll edit the message

    // Call backend to upsert reaction and get new count
    const { count } = await postJSON<{ count: number }>(`/runs/${runId}/reactions`, {
        userId: btn.user.id,
        state: 'join'
    });

    const msg = btn.message;
    // Rebuild embeds with updated Raiders count (first embed only)
    const embeds = msg.embeds;
    if (!embeds?.length) return;

    const first = EmbedBuilder.from(embeds[0]);
    const updated = setRaidersField(first, count);

    await msg.edit({ embeds: [updated, ...embeds.slice(1)] });
}
