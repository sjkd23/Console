import fp from 'fastify-plugin';
import { backendConfig } from '../config.js';
import { Errors } from '../lib/errors';
declare module 'fastify' {
    interface FastifyRequest {
        apiKeyValid?: boolean;
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
    });
});
