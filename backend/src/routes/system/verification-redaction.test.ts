import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    databaseQuery: vi.fn(),
    logError: vi.fn(),
}));

vi.mock('pg', () => ({
    Pool: class {
        query = state.databaseQuery;
        on() { return this; }
    },
}));
vi.mock('../../config.js', () => ({ backendConfig: { DATABASE_URL: 'postgres://test:test@localhost/test' } }));
vi.mock('../../lib/logging/logger.js', () => ({
    logger: { error: state.logError, debug: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import verificationRoutes from './verification.js';

describe('verification SQL failure logging', () => {
    const app = Fastify({ logger: false });
    const secret = 'SYNTHETIC_PRIVATE_DENIAL_REASON_8f74';

    afterEach(() => {
        state.databaseQuery.mockReset();
        state.logError.mockReset();
    });

    it('logs the failed query and error without logging the denial reason parameter', async () => {
        await app.register(verificationRoutes);
        state.databaseQuery.mockRejectedValueOnce(new Error('synthetic SQL failure'));

        const response = await app.inject({
            method: 'PATCH',
            url: '/verification/session/100000000000000001/100000000000000002',
            payload: { status: 'denied', denial_reason: secret },
        });

        expect(response.statusCode).toBe(500);
        expect(state.databaseQuery).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(state.databaseQuery.mock.calls[0][1])).toContain(secret);
        expect(state.logError).toHaveBeenCalledTimes(1);
        const [context, message] = state.logError.mock.calls[0];
        expect(message).toBe('Query failed');
        expect(context).toMatchObject({ params: '[redacted]', error: 'synthetic SQL failure' });
        expect(context.sql).toContain('UPDATE verification_session');
        expect(JSON.stringify(state.logError.mock.calls)).not.toContain(secret);
        await app.close();
    });
});
