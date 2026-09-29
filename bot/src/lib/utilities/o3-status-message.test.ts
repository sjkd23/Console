import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import type { Client, Guild, MessageCreateOptions, MessageEditOptions } from 'discord.js';
import { z } from 'zod';

const guild = { id: '100000000000000001' } as Guild;
const roleId = '100000000000000002';
const runs = new Map<number, ReturnType<typeof makeRun>>();
function makeRun(id: number) {
    return {
        id, runKind: 'oryx_3', channelId: '100000000000000003',
        postMessageId: '100000000000000004', roleId,
        pingMessageId: null as string | null,
        o3StatusMessageId: null as string | null,
        selectedDungeons: [{ dungeonKey: 'ORYX_3', dungeonLabel: 'Oryx 3', selectionOrder: 1 }],
        dungeonKey: 'ORYX_3', dungeonLabel: 'Oryx 3', party: 'Party', location: 'Location',
        keyPopCount: 1,
    };
}
const sends: MessageCreateOptions[] = [];
const edits: Array<{ id: string; payload: MessageEditOptions }> = [];
const deletes: string[] = [];
let failEdit = false;
const messages = new Map<string, ReturnType<typeof makeMessage>>();
function makeMessage(id: string, content = `@here <@&${roleId}>`) {
    return {
        id, content, deletable: true,
        edit: async (payload: MessageEditOptions) => {
            if (failEdit) throw new Error('Missing permissions');
            edits.push({ id, payload });
            messages.get(id)!.content = payload.content ?? '';
        },
        delete: async () => { deletes.push(id); messages.delete(id); },
    };
}
const channel = {
    isTextBased: () => true, isDMBased: () => false,
    messages: { fetch: async (id: string) => {
        const message = messages.get(id);
        if (!message) throw new Error('Unknown Message');
        return message;
    } },
    send: async (payload: MessageCreateOptions) => {
        sends.push(payload);
        const message = makeMessage(String(100 + sends.length), payload.content ?? '');
        messages.set(message.id, message);
        return message;
    },
};
const client = { channels: { fetch: async () => channel } } as unknown as Client;
mock.module('./http.js', { namedExports: {
    getRunDetails: async (id: number) => ({ ...runs.get(id)! }),
    getRunDisplayLabel: (run: ReturnType<typeof makeRun>) => run.dungeonLabel,
    postJSON: async (path: string, body: unknown) => {
        const id = Number(path.split('/')[2]);
        const run = runs.get(id)!;
        if (path.endsWith('/o3-status-message')) {
            run.o3StatusMessageId = z.object({ o3StatusMessageId: z.string() }).parse(body).o3StatusMessageId;
        } else {
            assert.ok(path.endsWith('/ping-message'));
            run.pingMessageId = z.object({ pingMessageId: z.string() }).parse(body).pingMessageId;
        }
    },
} });
mock.module('./dungeon-role-pings.js', { namedExports: {
    resolveDungeonRolePingIds: async () => ['100000000000000009'],
} });
const { sendRunPing, sendRealmScorePing, sendKeyPoppedPing } = await import('./run-ping.js');
const { sendO3ProgressionPing } = await import('./o3-progression.js');
const progress = (messageText: string) => sendO3ProgressionPing({
    client, guild, runId: 42, messageText, includePartyLocation: false,
});

beforeEach(() => {
    runs.clear(); runs.set(42, makeRun(42));
    sends.length = 0; edits.length = 0; deletes.length = 0;
    messages.clear(); failEdit = false;
});

describe('O3 status message lifecycle', () => {
    it('tracks Start and edits it on the first score, retaining all original mentions', async () => {
        const id = await sendRunPing(client, 42, guild);
        assert.equal(runs.get(42)!.o3StatusMessageId, id);
        assert.equal(runs.get(42)!.pingMessageId, null);
        assert.match(sends[0].content!, /Raid Starting!/);
        assert.equal(sends[0].allowedMentions, undefined);
        assert.equal(await sendRealmScorePing(client, 42, guild, 50), id);
        assert.equal(sends.length, 1);
        assert.match(edits[0].payload.content!, /Realm Score: 50%/);
        for (const mention of ['@here', `<@&${roleId}>`, '<@&100000000000000009>']) {
            assert.ok(sends[0].content!.includes(mention));
            assert.ok(edits[0].payload.content!.includes(mention));
        }
        assert.deepEqual(edits[0].payload.allowedMentions, { parse: [] });
        assert.deepEqual(deletes, []);
    });

    it('does not create a status message when no start announcement is tracked', async () => {
        assert.equal(await sendRealmScorePing(client, 42, guild, 50), null);
        assert.equal(await progress('Mini: Dammah'), null);
        assert.equal(sends.length, 0);
        assert.deepEqual(deletes, []);
    });

    it('edits repeated scores, closure, miniboss and third room on the same message without pings', async () => {
        const id = await sendRunPing(client, 42, guild);
        await sendRealmScorePing(client, 42, guild, 60);
        await progress('Realm Closed');
        await progress('Mini: Dammah');
        await sendRealmScorePing(client, 42, guild, 70);
        await progress('Mini: Beisa');
        await progress('Third Room - Join Sanctuary now!');
        assert.equal(sends.length, 1);
        assert.equal(edits.length, 6);
        for (const edit of edits) {
            assert.equal(edit.id, id);
            assert.deepEqual(edit.payload.allowedMentions, { parse: [] });
            assert.ok(edit.payload.content!.includes('@here'));
            assert.ok(edit.payload.content!.includes('<@&100000000000000009>'));
        }
        assert.match(edits[0].payload.content!, /Realm Score: 60%/);
        assert.match(edits[2].payload.content!, /Mini: Dammah/);
        assert.match(edits[4].payload.content!, /Mini: Beisa/);
        assert.match(edits[5].payload.content!, /Third Room - Join Sanctuary now!/);
        assert.deepEqual(deletes, []);
    });

    it('keeps dungeon-entered sends and role pings separate from status edits', async () => {
        const id = await sendRunPing(client, 42, guild);
        const keyId = await sendKeyPoppedPing(client, 42, guild, '2026-09-29T00:00:00Z');
        assert.notEqual(keyId, id);
        assert.match(sends[1].content!, /Dungeon Entered!/);
        assert.ok(sends[1].content!.includes(`<@&${roleId}>`));
        assert.equal(sends[1].allowedMentions, undefined);
        await progress('Mini: Dammah');
        assert.equal(edits[0].id, id);
        assert.equal(runs.get(42)!.pingMessageId, keyId);
        await sendKeyPoppedPing(client, 42, guild, '2026-09-29T00:01:00Z');
        assert.equal(sends.length, 3);
        assert.deepEqual(deletes, [keyId]);
        assert.ok(messages.has(id!));
    });

    it('starts a chained run with a fresh status even in the same channel', async () => {
        const oldId = await sendRunPing(client, 42, guild);
        runs.set(43, makeRun(43));
        const newId = await sendRunPing(client, 43, guild);
        assert.notEqual(newId, oldId);
        assert.equal(sends.length, 2);
        assert.equal(edits.length, 0);
        assert.ok(sends[1].content!.includes(`<@&${roleId}>`));
        await sendRealmScorePing(client, 43, guild, 20);
        assert.equal(edits[0].id, newId);
    });

    it('manual pings do not delete or replace the O3 start announcement', async () => {
        const id = await sendRunPing(client, 42, guild);
        await sendRunPing(client, 42, guild, 'ping');
        await progress('Mini: Dammah');
        assert.equal(edits[0].id, id);
        assert.deepEqual(deletes, []);
        assert.equal(runs.get(42)!.o3StatusMessageId, id);
    });

    it('preserves ordinary start-ping tracking for other dungeon types', async () => {
        runs.get(42)!.runKind = 'single';
        const id = await sendRunPing(client, 42, guild);
        assert.equal(runs.get(42)!.pingMessageId, id);
        assert.equal(runs.get(42)!.o3StatusMessageId, null);
        await sendRunPing(client, 42, guild, 'ping');
        assert.deepEqual(deletes, [id]);
    });

    it('uses persisted tracking without needing prior process memory', async () => {
        runs.get(42)!.o3StatusMessageId = 'persisted';
        messages.set('persisted', makeMessage('persisted'));
        await progress('Mini: Gemsbok');
        assert.equal(sends.length, 0);
        assert.equal(edits[0].id, 'persisted');
    });

    it('does not replace or clear a deleted tracked message', async () => {
        const id = await sendRunPing(client, 42, guild);
        messages.delete(id!);
        assert.equal(await sendRealmScorePing(client, 42, guild, 60), null);
        assert.equal(sends.length, 1);
        assert.equal(runs.get(42)!.o3StatusMessageId, id);
    });

    it('retains tracking after an edit failure and can retry', async () => {
        const id = await sendRunPing(client, 42, guild);
        failEdit = true;
        assert.equal(await progress('Mini: Dammah'), null);
        assert.equal(runs.get(42)!.o3StatusMessageId, id);
        failEdit = false;
        assert.equal(await progress('Mini: Dammah'), id);
        assert.equal(sends.length, 1);
    });

    it('serializes overlapping scores into edits of the start announcement', async () => {
        const id = await sendRunPing(client, 42, guild);
        const ids = await Promise.all([
            sendRealmScorePing(client, 42, guild, 50),
            sendRealmScorePing(client, 42, guild, 60),
        ]);
        assert.equal(ids[0], ids[1]);
        assert.equal(ids[0], id);
        assert.equal(sends.length, 1);
        assert.equal(edits.length, 2);
        assert.match(edits[1].payload.content!, /Realm Score: 60%/);
    });
});
