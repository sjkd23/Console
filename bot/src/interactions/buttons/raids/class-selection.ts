import {
    ButtonInteraction,
    EmbedBuilder,
    MessageFlags,
    StringSelectMenuBuilder,
    StringSelectMenuInteraction,
    ActionRowBuilder,
    ComponentType
} from 'discord.js';
import { ROTMG_CLASSES } from '../../../constants/classes.js';
import { patchJSON } from '../../../lib/http.js';

function setRaidersField(embed: EmbedBuilder, count: number): EmbedBuilder {
    const data = embed.toJSON();
    const fields = [...(data.fields ?? [])];

    const idx = fields.findIndex(f => (f.name ?? '').toLowerCase() === 'raiders');
    if (idx >= 0) {
        fields[idx] = { ...fields[idx], value: String(count) };
    } else {
        fields.push({ name: 'Raiders', value: String(count), inline: false });
    }

    return new EmbedBuilder(data).setFields(fields as any);
}

function updateClassField(embed: EmbedBuilder, classCounts: Record<string, number>): EmbedBuilder {
    const data = embed.toJSON();
    let fields = [...(data.fields ?? [])];

    // Filter out non-zero classes and format
    const entries = Object.entries(classCounts)
        .filter(([, count]) => count > 0)
        .sort(([a], [b]) => a.localeCompare(b)); // Sort alphabetically

    let classText: string;
    if (entries.length === 0) {
        classText = 'None selected';
    } else if (entries.length <= 6) {
        // For 6 or fewer classes, show on one line
        classText = entries.map(([cls, count]) => `${cls} (${count})`).join(', ');
    } else {
        // For more than 6 classes, format in columns (3 per line)
        const formatted = entries.map(([cls, count]) => `${cls} (${count})`);
        const lines: string[] = [];
        for (let i = 0; i < formatted.length; i += 3) {
            const chunk = formatted.slice(i, i + 3);
            lines.push(chunk.join(' • '));
        }
        classText = lines.join('\n');
    }

    const idx = fields.findIndex(f => (f.name ?? '').toLowerCase() === 'classes');
    if (idx >= 0) {
        fields[idx] = { ...fields[idx], value: classText };
    } else {
        // Insert after Raiders field
        const raidersIdx = fields.findIndex(f => (f.name ?? '').toLowerCase() === 'raiders');
        if (raidersIdx >= 0) {
            fields.splice(raidersIdx + 1, 0, { name: 'Classes', value: classText, inline: false });
        } else {
            fields.push({ name: 'Classes', value: classText, inline: false });
        }
    }

    return new EmbedBuilder(data).setFields(fields as any);
}

export async function handleClassSelection(btn: ButtonInteraction, runId: string) {
    // Create a select menu with all classes
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`class-select:${runId}`)
        .setPlaceholder('Choose your class')
        .addOptions(
            ROTMG_CLASSES.map(cls => ({
                label: cls,
                value: cls
            }))
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

    // Send ephemeral reply with the select menu
    await btn.reply({
        content: 'Select your class for this run:',
        components: [row],
        flags: MessageFlags.Ephemeral
    });

    // Wait for user to select
    try {
        const selectInteraction = await btn.channel?.awaitMessageComponent<ComponentType.StringSelect>({
            filter: i => i.customId === `class-select:${runId}` && i.user.id === btn.user.id,
            time: 60_000 // 60 seconds
        });

        if (!selectInteraction) return;

        await selectInteraction.deferUpdate();

        const selectedClass = selectInteraction.values[0];

        // Update backend with PATCH
        const result = await patchJSON<{ joinCount: number; classCounts: Record<string, number> }>(
            `/runs/${runId}/reactions`,
            {
                userId: btn.user.id,
                class: selectedClass
            }
        );

        // Update the original message embed
        const msg = btn.message;
        const embeds = msg.embeds ?? [];
        if (embeds.length > 0) {
            const first = EmbedBuilder.from(embeds[0]);
            const updatedWithCount = setRaidersField(first, result.joinCount);
            const updatedWithClasses = updateClassField(updatedWithCount, result.classCounts);

            await msg.edit({ embeds: [updatedWithClasses, ...embeds.slice(1)] });
        }

        // Confirm to user
        await selectInteraction.editReply({
            content: `✅ Class set to **${selectedClass}**`,
            components: []
        });
    } catch (error) {
        // Timeout or error - just log it
        console.error('Class selection timeout or error:', error);
    }
}
