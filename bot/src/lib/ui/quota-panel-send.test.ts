import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import { Collection, DiscordAPIError, type Client, type EmbedBuilder } from 'discord.js';
import { updateQuotaPanel } from './quota-panel.js';
import { buildQuotaConfigPanel } from './quota-config-panel.js';

function fixture(t: TestContext) {
    const state = { tracked: 'old', channel: 'channel', sendFailure: false, trackingFailure: false,
        missingChannel: false, deleted: false, fetchFailure: false, sends: [] as string[],
        edits: [] as string[], fetches: [] as string[], requests: [] as string[], embeds: [] as object[] };
    const config = { guild_id: 'guild', discord_role_id: 'role', required_points: 10,
        reset_at: '2000-01-01', panel_message_id: 'old', reset_interval_days: 14,
        base_exalt_points: 1, base_non_exalt_points: 0, misc_points_per_minute: 0.1, moderation_points: 0 };
    const active = { starts_at: '2026-09-01T12:00:00Z', ends_at: '2026-09-15T12:00:00Z', required_points: 10 };
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        state.requests.push(`${init?.method ?? 'GET'} ${url}`);
        if (url.endsWith('/channels')) return Response.json({ channels: { quota: state.channel || undefined } });
        if (url.includes('/leaderboard/')) return Response.json({ active_period: active,
            period_start: active.starts_at, period_end: active.ends_at,
            leaderboard: [{ user_id: 'member', earned_points: 15, carry_in: 5, effective_total: 20, runs: 1 }] });
        if (url.includes('/config/')) {
            if (init?.method === 'PUT') {
                if (state.trackingFailure) return Response.json({ error: 'Failed tracking' }, { status: 400 });
                const body: unknown = JSON.parse(String(init.body));
                assert.ok(typeof body === 'object');
                assert.ok(body && 'panel_message_id' in body && typeof body.panel_message_id === 'string');
                state.tracked = body.panel_message_id;
                assert.ok(state.sends.includes(state.tracked), 'tracking follows a successful send');
                assert.deepEqual(Object.keys(body).sort(), ['actor_has_admin_permission', 'actor_user_id', 'panel_message_id']);
            }
            return Response.json({ config: { ...config, panel_message_id: state.tracked }, active_period: active, dungeon_overrides: {} });
        }
        throw new Error(`Unexpected request ${url}`);
    });
    const channel = { isTextBased: () => true, isSendable: () => true,
        messages: { fetch: async (id: string) => {
            state.fetches.push(id);
            if (state.deleted) throw new DiscordAPIError({ message: 'Unknown Message', code: 10008 }, 10008, 404, 'GET', 'https://discord.test', {});
            if (state.fetchFailure) throw new Error('Permission denied');
            return { id, edit: async () => { state.edits.push(id); } };
        } },
        send: async (payload: { embeds: EmbedBuilder[] }) => {
            if (state.sendFailure) throw new Error('Discord send failed');
            const id = `new-${state.sends.length + 1}`;
            state.sends.push(id);
            state.embeds.push(payload.embeds[0].toJSON());
            return { id, url: `https://discord.test/${id}` };
        } };
    const guild = { id: 'guild', memberCount: 0, members: { cache: new Collection() },
        channels: { fetch: async () => state.missingChannel ? null : channel }, roles: { cache: new Collection() } };
    guild.roles.cache.set('role', { id: 'role', name: 'Organizers', guild, members: new Collection() });
    const client = { user: { id: 'bot' }, guilds: { cache: new Collection([['guild', guild]]) } } as unknown as Client;
    return { state, send: () => updateQuotaPanel(client, 'guild', 'role', config, undefined, true),
        refresh: () => updateQuotaPanel(client, 'guild', 'role', config) };
}

it('sends canonical points, carry and persisted dates, then refreshes only the replacement', async t => {
    const f = fixture(t);
    await f.send();
    assert.equal(f.state.tracked, 'new-1');
    assert.deepEqual(f.state.fetches, []);
    const embed = JSON.stringify(f.state.embeds[0]);
    assert.match(embed, /20 \(5 rollover\)/);
    for (const date of ['2026-09-01T12:00:00Z', '2026-09-15T12:00:00Z']) {
        assert.ok(embed.includes(String(Date.parse(date) / 1000)));
    }
    await f.refresh();
    assert.deepEqual(f.state.edits, ['new-1']);
    assert.ok(f.state.requests.every(r => !/finalize|reset|periods/.test(r)));
});

it('queues concurrent sends and a stale scheduled refresh', async t => {
    const f = fixture(t);
    await Promise.all([f.send(), f.send(), f.refresh()]);
    assert.equal(f.state.tracked, 'new-2');
    assert.deepEqual(f.state.edits, ['new-2']);
});

for (const scenario of ['channel', 'missingChannel', 'sendFailure', 'trackingFailure'] as const) {
    it(`preserves previous tracking on ${scenario} failure`, async t => {
        const f = fixture(t);
        if (scenario === 'channel') f.state.channel = '';
        else f.state[scenario] = true;
        await assert.rejects(f.send(), scenario === 'trackingFailure' ? /Panel sent.*tracking could not be saved/ : /channel|Discord send/);
        assert.equal(f.state.tracked, 'old');
        assert.equal(f.state.sends.length, scenario === 'trackingFailure' ? 1 : 0);
    });
}

it('Send Panel ignores a deleted old message and scheduled recovery remains supported', async t => {
    const f = fixture(t);
    f.state.deleted = true;
    await f.send();
    assert.deepEqual(f.state.fetches, []);
    await f.refresh();
    assert.equal(f.state.tracked, 'new-2');
});

it('ordinary refresh does not replace tracking after a non-deletion Discord failure', async t => {
    const f = fixture(t);
    f.state.fetchFailure = true;
    await f.refresh();
    assert.equal(f.state.tracked, 'old');
    assert.deepEqual(f.state.sends, []);
});

it('config panel exposes Send Panel and current interval wording', async t => {
    fixture(t);
    const panel = await buildQuotaConfigPanel('guild', 'role', 'admin');
    const buttons = panel.buttons.flatMap(row => row.toJSON().components);
    assert.ok(buttons.some(button => 'label' in button && button.label === 'Send Panel'));
    assert.match(JSON.stringify(panel.embed.toJSON()), /Reset Interval/);
    assert.doesNotMatch(JSON.stringify(panel.embed.toJSON()), /Next Interval/);
});

it('a failed replacement after a successful one leaves the successful panel tracked', async t => {
    const f = fixture(t);
    await f.send();
    f.state.sendFailure = true;
    await assert.rejects(f.send(), /Discord send failed/);
    await f.refresh();
    assert.equal(f.state.tracked, 'new-1');
    assert.deepEqual(f.state.edits, ['new-1']);
});
