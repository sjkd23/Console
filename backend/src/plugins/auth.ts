import fp from 'fastify-plugin';
import { backendConfig } from '../config.js';
import { Errors } from '../lib/errors/errors';
declare module 'fastify' {
    interface FastifyRequest {
        apiKeyValid?: boolean;
        guildContext?: {
            guildId: string;
        };
    }
    interface FastifyContextConfig {
        public?: boolean;
    }
}

// Simple API key auth via `x-api-key` header.
// We'll use this for bot->backend calls (no CORS needed; it's server-to-server).
export default fp(async (fastify) => {
    fastify.addHook('onRequest', async (req, reply) => {
        // Public route(s) can opt out by setting: req.routeOptions.config.public = true
        const isPublic = req.routeOptions?.config?.public === true;
        if (isPublic) return;

        const headerKey = req.headers['x-api-key'];
        if (!headerKey || headerKey !== backendConfig.BACKEND_API_KEY) {
            return Errors.unauthorized(reply);
        }
        req.apiKeyValid = true;

        // Extract guild context from x-guild-id header (if present)
        const guildId = req.headers['x-guild-id'];
        if (typeof guildId === 'string' && guildId.length > 0) {
            req.guildContext = { guildId };
        }
    });
});
