import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    type ButtonInteraction,
    MessageFlags,
    StringSelectMenuBuilder,
} from 'discord.js';
import { dungeonByCode } from '../../constants/dungeons/dungeon-helpers.js';
import type { DungeonInfo } from '../../constants/dungeons/dungeon-types.js';
import { detachHeadcountPanelForConversion } from '../state/headcount-panel-tracker.js';
import {
    buildHeadcountConversionOptions,
    getHeadcountConversionEndState,
    validateHeadcountRunSubset,
} from '../utilities/headcount-conversion.js';

/** Owns the ephemeral message until confirm, cancel, timeout, or error. */
export async function collectHeadcountRunSubset(
    btn: ButtonInteraction,
    publicMessageId: string,
    availableDungeons: readonly DungeonInfo[]
): Promise<{ interaction: ButtonInteraction; dungeons: DungeonInfo[] } | null> {
    let selectedCodes: string[] = [];
    // Keep the existing collector-only namespace distinct from the global
    // headcount:convert:<publicMessageId> button route, and isolate each session.
    const namespace = `headcount:convert_subset:${btn.id}`;
    const selectId = `${namespace}:select`;
    const confirmId = `${namespace}:confirm`;
    const cancelId = `${namespace}:cancel`;
    const render = () => {
        const validationError = validateHeadcountRunSubset(availableDungeons, selectedCodes);
        const menu = new StringSelectMenuBuilder()
            .setCustomId(selectId)
            .setPlaceholder('Choose a legal run subset')
            .setMinValues(1)
            .setMaxValues(Math.min(5, availableDungeons.length))
            .addOptions(buildHeadcountConversionOptions(availableDungeons, selectedCodes));
        const confirm = new ButtonBuilder()
            .setCustomId(confirmId)
            .setLabel('Convert Selection')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(validationError !== null);
        const cancel = new ButtonBuilder()
            .setCustomId(cancelId)
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary);
        return {
            content: 'Choose which dungeon(s) from this headcount should become the run. Nothing is selected by default, and the headcount remains active if you cancel.'
                + (validationError && selectedCodes.length > 0 ? `\n\n❌ ${validationError}` : ''),
            embeds: [],
            components: [
                new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
                new ActionRowBuilder<ButtonBuilder>().addComponents(confirm, cancel),
            ],
        };
    };

    await btn.deferUpdate();
    await detachHeadcountPanelForConversion(publicMessageId, btn.message.id);
    const replyMessage = await btn.editReply(render());

    return new Promise((resolve, reject) => {
        const collector = replyMessage.createMessageComponentCollector({
            filter: component => component.user.id === btn.user.id
                && component.message.id === replyMessage.id
                && ((component.isStringSelectMenu() && component.customId === selectId)
                    || (component.isButton() && (component.customId === confirmId || component.customId === cancelId))),
            time: 60_000,
        });
        let finished = false;
        let pending = Promise.resolve();

        collector.on('collect', component => {
            // Serialize edits so a slow selection update cannot overwrite timeout cleanup.
            pending = pending.then(async () => {
                if (finished) return;
                if (component.isStringSelectMenu()) {
                    selectedCodes = [...component.values];
                    await component.update(render());
                    return;
                }
                if (!component.isButton()) return;
                if (component.customId === cancelId) {
                    await component.deferUpdate();
                    if (!finished) collector.stop('cancelled');
                    return;
                }
                const validationError = validateHeadcountRunSubset(availableDungeons, selectedCodes);
                if (validationError) {
                    await component.reply({ content: validationError, flags: MessageFlags.Ephemeral });
                    return;
                }
                await component.deferUpdate();
                if (finished) return;
                collector.stop('confirmed');
                resolve({ interaction: component, dungeons: selectedCodes.map(code => dungeonByCode[code]) });
            }).catch(async error => {
                finished = true;
                collector.stop('error');
                await btn.editReply({
                    content: 'Conversion failed. Reopen the headcount organizer panel to try again.',
                    embeds: [],
                    components: [],
                }).catch(() => undefined);
                reject(error);
            });
        });
        collector.once('end', (_collected, reason) => {
            finished = true;
            if (reason === 'confirmed' || reason === 'error') return;
            void pending.then(async () => {
                const endState = getHeadcountConversionEndState(reason === 'cancelled' ? 'cancelled' : 'timeout');
                await btn.editReply({ content: endState.message!, embeds: [], components: [] }).catch(() => undefined);
                resolve(null);
            });
        });
    });
}
