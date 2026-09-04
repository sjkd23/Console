import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it, mock } from 'node:test';
import type { Client, GuildMember } from 'discord.js';

interface AwardCall {
    guildId: string;
    userId: string;
    payload: {
        actor_user_id: string;
        actor_roles?: string[];
        command_type?: string;
        subject_id?: string;
    };
}

const awardCalls: AwardCall[] = [];
let configuredVerificationPoints = 1;

mock.module('../permissions/permissions.js', {
    namedExports: {
        getMemberRoleIds: () => ['100000000000000004'],
    },
});

mock.module('../utilities/http.js', {
    namedExports: {
        awardModerationPointsWithUpdate: async (
            _client: Client,
            guildId: string,
            userId: string,
            payload: AwardCall['payload']
        ) => {
            awardCalls.push({ guildId, userId, payload });
            return { points_awarded: configuredVerificationPoints };
        },
    },
});

const { awardManualVerificationCredit } = await import('./manual-verification-credit.js');

const client = {} as Client;
const reviewer = { id: '100000000000000002' } as GuildMember;
const baseSession = {
    guild_id: '100000000000000001',
    user_id: '100000000000000003',
    ticket_message_id: '100000000000000005',
    created_at: '2026-09-03T12:00:00.000Z',
};

describe('manual verification quota credit', () => {
    it('routes both approval and rejection through the existing verify-point accounting setting', async () => {
        awardCalls.length = 0;
        configuredVerificationPoints = 1;

        const approval = await awardManualVerificationCredit(client, baseSession, reviewer);
        const rejection = await awardManualVerificationCredit(
            client,
            { ...baseSession, ticket_message_id: '100000000000000006' },
            reviewer
        );

        assert.equal(approval.points_awarded, 1);
        assert.equal(rejection.points_awarded, 1);
        assert.equal(awardCalls.length, 2);
        for (const call of awardCalls) {
            assert.equal(call.guildId, baseSession.guild_id);
            assert.equal(call.userId, reviewer.id);
            assert.equal(call.payload.command_type, 'verify');
            assert.deepEqual(call.payload.actor_roles, ['100000000000000004']);
        }
    });

    it('passes through zero and changed verification-point values equally for either decision', async () => {
        for (const points of [0, 3.75]) {
            configuredVerificationPoints = points;
            const approval = await awardManualVerificationCredit(
                client,
                { ...baseSession, ticket_message_id: `approval-${points}` },
                reviewer
            );
            const rejection = await awardManualVerificationCredit(
                client,
                { ...baseSession, ticket_message_id: `rejection-${points}` },
                reviewer
            );
            assert.equal(approval.points_awarded, points);
            assert.equal(rejection.points_awarded, points);
        }
    });

    it('hooks approval and both rejection outcomes into the same helper without separate rejection configuration', async () => {
        const handlerSource = await readFile(
            new URL('../../interactions/buttons/verification/approve-deny.ts', import.meta.url),
            'utf8'
        );
        const quotaUiSource = await readFile(
            new URL('../../interactions/buttons/config/quota-config.ts', import.meta.url),
            'utf8'
        );
        const separateSettingName = ['reject', 'verification', 'points'].join('_');

        assert.equal((handlerSource.match(/awardManualVerificationCredit\(/g) ?? []).length, 3);
        assert.doesNotMatch(handlerSource, new RegExp(separateSettingName));
        assert.doesNotMatch(quotaUiSource, new RegExp(separateSettingName));
    });
});
