import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    type ChatInputCommandInteraction,
    StringSelectMenuBuilder,
} from 'discord.js';
import { dungeonByCode, getCategorizedDungeons } from '../../constants/dungeons/dungeon-helpers.js';
import type { DungeonInfo } from '../../constants/dungeons/dungeon-types.js';

export interface DungeonSelectionPolicy {
    namespace: 'run-select' | 'headcount-select';
    title: string;
    instructions: string;
    confirmLabel: string;
    validate(dungeons: readonly DungeonInfo[]): string | null;
}

interface CategoryDefinition {
    id: 'exalt' | 'misc1' | 'misc2';
    placeholder: string;
    dungeons: DungeonInfo[];
}

const DISCORD_MESSAGE_URL = /^https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+$/;

export function buildDungeonSelectionSuccessState(runUrl: string) {
    if (!DISCORD_MESSAGE_URL.test(runUrl)) {
        throw new Error('Cannot show selector success before a published Discord run message exists.');
    }

    return {
        content: `Run created and posted: [Jump to run](${runUrl})`,
        components: [],
        embeds: [],
    };
}

export async function collectDungeonSelection(
    interaction: ChatInputCommandInteraction,
    policy: DungeonSelectionPolicy
): Promise<DungeonInfo[] | null> {
    const categorized = getCategorizedDungeons();
    const categories: CategoryDefinition[] = [
        { id: 'exalt', placeholder: 'Select Exaltation dungeons', dungeons: categorized.exalt.slice(0, 25) },
        { id: 'misc1', placeholder: 'Select other dungeons (part 1)', dungeons: categorized.misc1.slice(0, 25) },
        { id: 'misc2', placeholder: 'Select other dungeons (part 2)', dungeons: categorized.misc2.slice(0, 25) },
    ];
    const selectedByCategory = new Map<string, string[]>();
    let selectedOrder: string[] = [];

    const getSelectedDungeons = (): DungeonInfo[] => selectedOrder
        .map(code => dungeonByCode[code])
        .filter((dungeon): dungeon is DungeonInfo => dungeon !== undefined);

    const render = () => {
        const selected = getSelectedDungeons();
        const validationError = selected.length === 0 ? 'Select at least one dungeon.' : policy.validate(selected);
        const summary = selected.length > 0
            ? selected.map((dungeon, index) => `${index + 1}. ${dungeon.dungeonName}`).join('\n')
            : 'None';

        const menuRows = categories.map(category => {
            const current = new Set(selectedByCategory.get(category.id) ?? []);
            const menu = new StringSelectMenuBuilder()
                .setCustomId(`${policy.namespace}:${category.id}`)
                .setPlaceholder(category.placeholder)
                .setMinValues(0)
                .setMaxValues(Math.min(5, category.dungeons.length))
                .addOptions(category.dungeons.map(dungeon => ({
                    label: dungeon.dungeonName,
                    value: dungeon.codeName,
                    description: dungeon.dungeonCategory || undefined,
                    default: current.has(dungeon.codeName),
                })));
            return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
        });

        const confirm = new ButtonBuilder()
            .setCustomId(`${policy.namespace}:confirm`)
            .setLabel(policy.confirmLabel)
            .setStyle(ButtonStyle.Primary)
            .setDisabled(validationError !== null);
        const cancel = new ButtonBuilder()
            .setCustomId(`${policy.namespace}:cancel`)
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary);

        return {
            content: `**${policy.title}**\n\n${policy.instructions}\n\n**Selected (${selected.length}/5):**\n${summary}`
                + (validationError && selected.length > 0 ? `\n\n❌ ${validationError}` : ''),
            components: [
                ...menuRows,
                new ActionRowBuilder<ButtonBuilder>().addComponents(confirm, cancel),
            ],
        };
    };

    const replyMessage = await interaction.editReply(render());

    return new Promise(resolve => {
        const collector = replyMessage.createMessageComponentCollector({
            filter: component => component.user.id === interaction.user.id
                && component.customId.startsWith(`${policy.namespace}:`),
            time: 120_000,
        });

        collector.on('collect', async component => {
            if (component.isStringSelectMenu()) {
                await component.deferUpdate();
                const categoryId = component.customId.slice(policy.namespace.length + 1);
                const category = categories.find(candidate => candidate.id === categoryId);
                if (!category) return;

                const categoryCodes = new Set(category.dungeons.map(dungeon => dungeon.codeName));
                const retainedOutsideCategory = selectedOrder.filter(code => !categoryCodes.has(code));
                const nextTotal = new Set([...retainedOutsideCategory, ...component.values]).size;
                if (nextTotal > 5) {
                    await component.followUp({
                        content: 'You can select at most 5 dungeons total.',
                        ephemeral: true,
                    });
                    return;
                }

                const nextValues = new Set(component.values);
                selectedOrder = selectedOrder.filter(code => !categoryCodes.has(code) || nextValues.has(code));
                selectedByCategory.set(category.id, [...component.values]);
                for (const code of component.values) {
                    if (!selectedOrder.includes(code)) selectedOrder.push(code);
                }
                await interaction.editReply(render());
                return;
            }

            if (!component.isButton()) return;
            if (component.customId.endsWith(':cancel')) {
                await component.deferUpdate();
                collector.stop('cancelled');
                return;
            }

            if (component.customId.endsWith(':confirm')) {
                const selected = getSelectedDungeons();
                const error = policy.validate(selected);
                if (error) {
                    await component.reply({ content: error, ephemeral: true });
                    return;
                }
                await component.deferUpdate();
                collector.stop('confirmed');
            }
        });

        collector.once('end', async (_collected, reason) => {
            if (reason === 'confirmed') {
                resolve(getSelectedDungeons());
                return;
            }
            const message = reason === 'cancelled'
                ? 'Dungeon selection cancelled.'
                : '⏱️ Dungeon selection timed out. Run the command again when ready.';
            await interaction.editReply({ content: message, components: [] }).catch(() => undefined);
            resolve(null);
        });
    });
}
