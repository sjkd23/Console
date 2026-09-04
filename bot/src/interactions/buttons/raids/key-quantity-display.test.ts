import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EmbedBuilder, type ButtonInteraction, type Message, type ModalBuilder } from 'discord.js';
import { buildHeadcountOrganizerPanelContent } from './headcount-organizer-panel.js';
import { clearKeyOffers, getKeyOffers, handleHeadcountKey, updateHeadcountKeyDisplay } from './headcount-key.js';
import { buildOrganizerKeyDescription } from './organizer-panel.js';
import { handleKeyReaction, updateRunKeysField } from './key-reaction.js';
import {
    parseKeyQuantityAction,
    resolveKeyQuantityIntent,
    setKeyOfferQuantity,
    type HeadcountKeyOfferStore,
} from '../../../lib/utilities/key-quantity.js';
import { registerHeadcount, unregisterHeadcount } from '../../../lib/state/active-headcount-tracker.js';

describe('key quantity displays', () => {
    it('opens a run quantity modal with the correct context and key intent', async () => {
        const shown: ModalBuilder[] = [];
        const button = {
            guildId: 'guild-1',
            user: { id: 'user-1', bot: false },
            showModal: async (modal: ModalBuilder) => { shown.push(modal); },
        } as unknown as ButtonInteraction;
        await handleKeyReaction(button, '42', 'NEST_KEY');
        assert.equal(shown.length, 1);
        const action = parseKeyQuantityAction(shown[0].toJSON().custom_id);
        assert.ok(action);
        assert.deepEqual(resolveKeyQuantityIntent(action.token), {
            context: 'run', runId: '42', userId: 'user-1', keyType: 'NEST_KEY',
        });
    });

    it('opens a headcount quantity modal for the exact dungeon and key', async () => {
        const shown: ModalBuilder[] = [];
        registerHeadcount('guild-1', 'organizer-1', 'message-1', 'channel-1', ['Nest'], ['NEST']);
        const button = {
            guild: { id: 'guild-1' },
            user: { id: 'user-1', bot: false },
            message: { id: 'message-1' },
            showModal: async (modal: ModalBuilder) => { shown.push(modal); },
        } as unknown as ButtonInteraction;
        try {
            await handleHeadcountKey(button, 'panel-token', 'NEST', 'NEST_KEY');
            assert.equal(shown.length, 1);
            const action = parseKeyQuantityAction(shown[0].toJSON().custom_id);
            assert.ok(action);
            assert.deepEqual(resolveKeyQuantityIntent(action.token), {
                context: 'headcount', messageId: 'message-1', userId: 'user-1',
                dungeonCode: 'NEST', keyType: 'NEST_KEY',
            });
        } finally {
            unregisterHeadcount('guild-1', 'organizer-1');
            clearKeyOffers('message-1');
        }
    });

    it('shows only per-key quantity totals on the public headcount panel', () => {
        const offers: HeadcountKeyOfferStore = new Map();
        setKeyOfferQuantity(offers, 'LOST_HALLS', 'CULT_KEY', 'user-1', 3);
        setKeyOfferQuantity(offers, 'LOST_HALLS', 'CULT_KEY', 'user-2', 2);
        setKeyOfferQuantity(offers, 'FUNGAL_CAVERN', 'FUNGAL_CAVERN_KEY', 'user-3', 4);
        const embed = updateHeadcountKeyDisplay(
            new EmbedBuilder()
                .setDescription('Organizer: <@organizer>')
                .addFields({ name: 'Total Keys', value: '0' }),
            offers
        ).toJSON();

        assert.match(embed.description ?? '', /Cult Key: 5/);
        assert.match(embed.description ?? '', /Fungal Cavern: 4/);
        assert.doesNotMatch(embed.description ?? '', /user-[123]|\btotal\b|\busers?\b/i);
        assert.equal(embed.fields?.some(field => field.name === 'Total Keys' || field.name === 'Keys'), false);
    });

    it('shows only per-key quantity totals on the public active-run Keys field', () => {
        const embed = updateRunKeysField(new EmbedBuilder().setTitle('Run'), {
            NEST_KEY: [{ userId: 'user-1', quantity: 3 }, { userId: 'user-2', quantity: 2 }],
        }).toJSON();
        const keys = embed.fields?.find(field => field.name === 'Keys')?.value ?? '';
        assert.match(keys, /Nest: 5/);
        assert.doesNotMatch(keys, /<@|\btotal\b|\busers?\b/i);
    });

    it('shows headcount and raid quantities in the run organizer panel format', () => {
        const text = buildOrganizerKeyDescription(
            { NEST_KEY: [{ userId: 'user-1', quantity: 3 }] },
            { NEST_KEY: [{ userId: 'user-2', quantity: 2 }] }
        );
        assert.match(text, /Headcount Keys:[\s\S]*<@user-1> ×3/);
        assert.match(text, /Raid Keys:[\s\S]*<@user-2> ×2/);
        assert.doesNotMatch(text, /\btotal\b|\bfrom \d+ users?\b/i);
    });

    it('shows quantities in the headcount organizer panel', () => {
        const messageId = 'headcount-display-test';
        setKeyOfferQuantity(getKeyOffers(messageId), 'NEST', 'NEST_KEY', 'user-1', 6);
        const publicMessage = { id: messageId, components: [] } as unknown as Message;
        const content = buildHeadcountOrganizerPanelContent(
            publicMessage,
            new EmbedBuilder(),
            ['NEST']
        );
        const description = content.embeds[0].toJSON().description ?? '';
        assert.match(description, /Nest.*<@user-1> ×6/);
        assert.doesNotMatch(description, /\btotal\b|\bfrom \d+ users?\b/i);
    });
});
