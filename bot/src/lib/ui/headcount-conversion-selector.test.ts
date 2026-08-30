import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import {
    Client,
    ComponentType,
    EmbedBuilder,
    InteractionCollector,
    InteractionType,
    type ButtonInteraction,
    type Message,
    type MessageComponentCollectorOptions,
    type CollectedMessageInteraction,
    type InteractionWebhook,
} from 'discord.js';
import { z } from 'zod';
import { dungeonByCode } from '../../constants/dungeons/dungeon-helpers.js';
import {
    showHeadcountPanel,
    updateHeadcountOrganizerPanel,
} from '../../interactions/buttons/raids/headcount-organizer-panel.js';
import {
    clearHeadcountPanels,
    getActiveHeadcountPanels,
    registerHeadcountPanel,
    type HeadcountOrganizerPanelHandle,
} from '../state/headcount-panel-tracker.js';
import { buttonMutex, withButtonLock } from '../utilities/button-mutex.js';
import { collectHeadcountRunSubset } from './headcount-conversion-selector.js';

const payloadSchema = z.object({
    content: z.string().optional(),
    embeds: z.array(z.unknown()).optional(),
    components: z.array(z.object({
        components: z.array(z.object({
            custom_id: z.string(),
            disabled: z.boolean().optional(),
            options: z.array(z.object({ value: z.string(), default: z.boolean().optional() })).optional(),
        })),
    })).optional(),
});
type View = z.infer<typeof payloadSchema>;
const publicId = '100';
const panelId = '200';
const userId = '300';
const available = ['REALM_DUNGEON', 'NEST', 'SNAKE_PIT', 'ORYX_3', 'WOODLAND_LABYRINTH']
    .map(code => dungeonByCode[code]);

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

function harness() {
    const client = new Client<true>({ intents: [] });
    const collectors: InteractionCollector<CollectedMessageInteraction>[] = [];
    const edits: View[] = [];
    const replies: View[] = [];
    let view: View = {};
    let nextWriteGate: Promise<void> | undefined;
    let session = 0;
    let eventId = 0;
    const apply = async (payload: unknown) => {
        const gate = nextWriteGate;
        nextWriteGate = undefined;
        if (gate) await gate;
        const patch = payloadSchema.parse(JSON.parse(JSON.stringify(payload)) as unknown);
        edits.push(patch);
        // Discord PATCH preserves omitted fields: this is essential to the original bug.
        view = { ...view, ...patch };
        return panelMessage;
    };
    const panelMessage = {
        id: panelId,
        channelId: '400',
        guildId: '500',
        createMessageComponentCollector(options: MessageComponentCollectorOptions<CollectedMessageInteraction>) {
            const collector = new InteractionCollector<CollectedMessageInteraction>(client, {
                ...options,
                message: panelMessage,
                interactionType: InteractionType.MessageComponent,
            });
            collectors.push(collector);
            return collector;
        },
    } as unknown as Message<true>;
    const publicMessage = { id: publicId } as Message<true>;
    const embed = new EmbedBuilder().setDescription(`Organizer: <@${userId}>`);
    const button = () => ({
        id: `session-${++session}`,
        user: { id: userId, username: 'Organizer' },
        message: panelMessage,
        deferUpdate: async () => undefined,
        update: apply,
        editReply: apply,
        reply: async (payload: unknown) => ({ resource: { message: await apply(payload) } }),
        fetchReply: async () => panelMessage,
    }) as unknown as ButtonInteraction;

    return {
        client,
        collectors,
        edits,
        replies,
        get view() { return view; },
        get collector() { return collectors[collectors.length - 1]; },
        gateNextWrite(promise: Promise<void>) { nextWriteGate = promise; },
        components() { return view.components?.flatMap(row => row.components) ?? []; },
        selected() {
            return this.components().flatMap(component => component.options ?? [])
                .filter(option => option.default).map(option => option.value);
        },
        async open() {
            await showHeadcountPanel(button(), publicMessage, embed, userId, available.map(dungeon => dungeon.codeName));
            const handle = getActiveHeadcountPanels(publicId).at(-1)!;
            assert.ok(handle.type === 'interactionReply');
            return handle;
        },
        async openFollowup() {
            const handle: HeadcountOrganizerPanelHandle = {
                type: 'followup',
                messageId: panelId,
                webhook: { editMessage: async (_messageId: string, payload: unknown) => apply(payload) } as unknown as InteractionWebhook,
            };
            registerHeadcountPanel(publicId, handle);
            await this.refresh(handle);
            return handle;
        },
        start() {
            const btn = button();
            const result = collectHeadcountRunSubset(btn, publicId, available);
            return { btn, result };
        },
        startLocked() {
            const btn = button();
            let result: Awaited<ReturnType<typeof collectHeadcountRunSubset>> | undefined;
            const completion = withButtonLock(btn, `headcount:convert:${publicId}`, async () => {
                result = await collectHeadcountRunSubset(btn, publicId, available);
            }, { holdUntilSettled: true });
            return { btn, completion, get result() { return result; } };
        },
        refresh(handle: HeadcountOrganizerPanelHandle) {
            return updateHeadcountOrganizerPanel(handle, publicMessage, embed, available.map(dungeon => dungeon.codeName));
        },
        async emit(action: 'select' | 'confirm' | 'cancel', values: string[] = [], overrides: {
            customId?: string; messageId?: string; userId?: string;
        } = {}) {
            const customId = overrides.customId ?? this.components().find(component => component.custom_id.endsWith(`:${action}`))?.custom_id;
            assert.ok(customId, `missing ${action} component`);
            const interaction = {
                id: `event-${++eventId}`,
                type: InteractionType.MessageComponent,
                componentType: action === 'select' ? ComponentType.StringSelect : ComponentType.Button,
                channelId: panelMessage.channelId,
                guildId: panelMessage.guildId,
                message: { id: overrides.messageId ?? panelId },
                user: { id: overrides.userId ?? userId },
                customId,
                values,
                isStringSelectMenu: () => action === 'select',
                isButton: () => action !== 'select',
                update: apply,
                reply: async (payload: unknown) => {
                    replies.push(payloadSchema.parse(JSON.parse(JSON.stringify(payload)) as unknown));
                },
                deferUpdate: async () => undefined,
            } as unknown as CollectedMessageInteraction;
            client.emit('interactionCreate', interaction);
            await setImmediate();
        },
    };
}

afterEach(() => {
    clearHeadcountPanels(publicId);
    buttonMutex.clearAll();
});

describe('headcount conversion ephemeral ownership', () => {
    it('opens the organizer panel, selects without a stale refresh restoring it, then confirms', async () => {
        const ui = harness();
        const oldHandle = await ui.open();
        assert.ok(ui.components().some(component => component.custom_id === `headcount:convert:${publicId}`));
        const flow = ui.startLocked();
        await setImmediate();
        assert.deepEqual(ui.selected(), []);
        assert.equal(ui.client.listenerCount('interactionCreate'), 1);
        // Same auto-join/key/participant refresh path that used to overwrite the selector.
        await ui.refresh(oldHandle);
        await ui.emit('select', ['NEST']);
        await ui.refresh(oldHandle);
        assert.deepEqual(ui.selected(), ['NEST']);
        assert.ok(ui.components().every(component => component.custom_id.startsWith('headcount:convert_subset:')));
        assert.ok(ui.edits.every(edit => !edit.content?.includes('Choose at least one dungeon')));
        await ui.emit('confirm');
        await flow.completion;
        assert.deepEqual(flow.result?.dungeons.map(dungeon => dungeon.codeName), ['NEST']);
        assert.equal(ui.collector.ended, true);
        assert.equal(ui.client.listenerCount('interactionCreate'), 0);
        assert.equal(buttonMutex.isLocked(`headcount:convert:${publicId}`), false);
    });

    it('keeps all original choices and accepts multiple legal selections', async () => {
        const ui = harness();
        await ui.open();
        const flow = ui.start();
        await setImmediate();
        assert.deepEqual(ui.components()[0].options?.map(option => option.value), available.map(dungeon => dungeon.codeName));
        await ui.emit('select', ['REALM_DUNGEON', 'SNAKE_PIT']);
        assert.deepEqual(ui.selected(), ['REALM_DUNGEON', 'SNAKE_PIT']);
        await ui.emit('confirm');
        assert.deepEqual((await flow.result)?.dungeons.map(dungeon => dungeon.codeName), ['REALM_DUNGEON', 'SNAKE_PIT']);
    });

    it('emits the empty-selection error only on an attempted empty confirm', async () => {
        const ui = harness();
        await ui.open();
        const flow = ui.start();
        await setImmediate();
        assert.equal(ui.view.content?.includes('Choose at least one dungeon'), false);
        await ui.emit('confirm');
        assert.equal(ui.replies.at(-1)?.content, 'Choose at least one dungeon.');
        assert.ok(ui.components()[0].custom_id.endsWith(':select'));
        await ui.emit('cancel');
        assert.equal(await flow.result, null);
    });

    it('also detaches the auto-popup followup handle from organizer refreshes', async () => {
        const ui = harness();
        const handle = await ui.openFollowup();
        const flow = ui.start();
        await setImmediate();
        await ui.emit('select', ['WOODLAND_LABYRINTH']);
        await ui.refresh(handle);
        assert.deepEqual(ui.selected(), ['WOODLAND_LABYRINTH']);
        await ui.emit('confirm');
        assert.deepEqual((await flow.result)?.dungeons.map(dungeon => dungeon.codeName), ['WOODLAND_LABYRINTH']);
    });

    it('retains run-subset validation without closing the selector for an illegal choice', async () => {
        const ui = harness();
        await ui.open();
        const flow = ui.start();
        await setImmediate();
        await ui.emit('select', ['REALM_DUNGEON', 'NEST']);
        assert.match(ui.view.content ?? '', /cannot mix/i);
        assert.equal(ui.components().find(component => component.custom_id.endsWith(':confirm'))?.disabled, true);
        await ui.emit('confirm');
        assert.match(ui.replies.at(-1)?.content ?? '', /cannot mix/i);
        assert.equal(ui.collector.ended, false);
        await ui.emit('cancel');
        assert.equal(await flow.result, null);
    });

    it('drains an in-flight organizer refresh and rejects already-copied stale handles', async () => {
        const ui = harness();
        const handle = await ui.open();
        const otherHandle: HeadcountOrganizerPanelHandle = { ...handle, messageId: 'other-panel' };
        registerHeadcountPanel(publicId, otherHandle);
        const gate = deferred();
        ui.gateNextWrite(gate.promise);
        const refresh = ui.refresh(handle);
        const flow = ui.start();
        await setImmediate();
        assert.equal(ui.collectors.length, 0); // ownership waits for the old REST edit
        gate.resolve();
        await refresh;
        await setImmediate();
        await ui.refresh(handle);
        assert.deepEqual(getActiveHeadcountPanels(publicId), [otherHandle]);
        assert.ok(ui.components()[0].custom_id.endsWith(':select'));
        await ui.emit('cancel');
        await flow.result;
    });

    for (const ending of ['cancel', 'timeout'] as const) {
        it(`${ending} stops the collector/releases the lock and permits immediate reopen`, async () => {
            const ui = harness();
            await ui.open();
            const flow = ui.startLocked();
            await setImmediate();
            const oldSelectId = ui.components()[0].custom_id;
            if (ending === 'cancel') await ui.emit('cancel');
            else ui.collector.stop('time');
            await flow.completion;
            assert.equal(flow.result, null);
            assert.deepEqual(ui.view.components, []);
            assert.match(ui.view.content ?? '', /headcount remains active/i);
            assert.equal(ui.client.listenerCount('interactionCreate'), 0);
            assert.equal(buttonMutex.isLocked(`headcount:convert:${publicId}`), false);
            await ui.open();
            const reopened = ui.startLocked();
            await setImmediate();
            await ui.emit('select', ['NEST'], { customId: oldSelectId });
            assert.deepEqual(ui.selected(), []);
            await ui.emit('select', ['SNAKE_PIT']);
            await ui.emit('confirm');
            await reopened.completion;
            assert.deepEqual(reopened.result?.dungeons.map(dungeon => dungeon.codeName), ['SNAKE_PIT']);
        });
    }

    it('ignores other users, messages, and organizer-mode components', async () => {
        const ui = harness();
        await ui.open();
        const flow = ui.start();
        await setImmediate();
        await ui.emit('select', ['NEST'], { userId: 'someone-else' });
        await ui.emit('select', ['NEST'], { messageId: 'another-message' });
        await ui.emit('confirm', [], { customId: `headcount:convert:${publicId}` });
        assert.equal(ui.collector.total, 0);
        assert.deepEqual(ui.selected(), []);
        await ui.emit('cancel');
        await flow.result;
    });

    it('does not let a slow select edit overwrite timeout cleanup', async () => {
        const ui = harness();
        await ui.open();
        const flow = ui.start();
        await setImmediate();
        const gate = deferred();
        ui.gateNextWrite(gate.promise);
        await ui.emit('select', ['NEST']);
        ui.collector.stop('time');
        gate.resolve();
        assert.equal(await flow.result, null);
        assert.deepEqual(ui.view.components, []);
        assert.match(ui.view.content ?? '', /timed out/i);
    });

    it('holds duplicate-click protection past 30 seconds until the selector settles', async context => {
        const ui = harness();
        await ui.open();
        const flow = ui.startLocked();
        await setImmediate();
        const now = Date.now();
        const clock = context.mock.method(Date, 'now', () => now + 45_000);
        assert.equal(buttonMutex.isLocked(`headcount:convert:${publicId}`), true);
        let duplicateRan = false;
        assert.equal(await withButtonLock(flow.btn, `headcount:convert:${publicId}`, async () => {
            duplicateRan = true;
        }, { holdUntilSettled: true }), false);
        assert.equal(duplicateRan, false);
        clock.mock.restore();
        await ui.emit('cancel');
        await flow.completion;
        assert.equal(buttonMutex.isLocked(`headcount:convert:${publicId}`), false);
    });

    it('stops the collector and releases the lock on a failed select edit', async () => {
        const ui = harness();
        await ui.open();
        const flow = ui.startLocked();
        const rejection = assert.rejects(flow.completion, /Discord edit failed/);
        await setImmediate();
        ui.gateNextWrite(Promise.reject(new Error('Discord edit failed')));
        await ui.emit('select', ['NEST']);
        await rejection;
        assert.equal(ui.collector.ended, true);
        assert.equal(ui.client.listenerCount('interactionCreate'), 0);
        assert.equal(buttonMutex.isLocked(`headcount:convert:${publicId}`), false);
        assert.deepEqual(ui.view.components, []);
    });
});
