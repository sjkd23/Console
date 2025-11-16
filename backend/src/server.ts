import 'dotenv/config';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { FastifyRequest } from 'fastify';
import { backendConfig } from './config.js';
import { defaultRateLimitOptions } from './lib/rate-limit/config.js';
import { Errors } from './lib/errors/errors.js';
import authPlugin from './plugins/auth.js';
import healthRoutes from './routes/system/health.js';
import runsRoutes from './routes/raid/runs.js';
import raidersRoutes from './routes/raid/raiders.js';
import guildsRoutes from './routes/admin/guilds.js';
import punishmentsRoutes from './routes/moderation/punishments.js';
import quotaRoutes from './routes/raid/quota.js';
import notesRoutes from './routes/moderation/notes.js';
import verificationRoutes from './routes/system/verification.js';
import commandLogRoutes from './routes/admin/command-log.js';
import modmailRoutes from './routes/moderation/modmail.js';

const app = Fastify({ logger: true });

// Rate limiting: Protect against abusive traffic (leaked keys, buggy scripts, etc.)
// Uses x-api-key as the rate limit key (all bot traffic shares same counter)
// Defaults are generous to not interfere with normal raid activity
await app.register(rateLimit, {
    ...defaultRateLimitOptions,
    errorResponseBuilder: (req: FastifyRequest, context: any) => {
        // Create safe key identifier for logging (never log raw secrets)
        const rawKey = req.headers['x-api-key'] as string | undefined;
        const keyFingerprint = context.ban 
            ? 'banned' 
            : rawKey 
                ? rawKey.slice(0, 6) + '…' 
                : 'anonymous';

        // Log rate limit violations for monitoring
        app.log.warn({
            keyFingerprint,
            url: req.url,
            method: req.method,
            max: context.max,
            ttl: context.ttl,
            after: context.after,
        }, 'Rate limit exceeded');

        // Return error in consistent format (matches ApiErrorPayload shape)
        return {
            error: {
                code: 'RATE_LIMITED',
                message: `Too many requests. Limit: ${context.max} requests per ${Math.round(context.ttl / 1000)}s. Try again in ${Math.ceil(context.ttl / 1000)}s.`
            }
        };
    },
});

await app.register(authPlugin);
await app.register(healthRoutes, { prefix: '/v1' });
await app.register(runsRoutes, { prefix: '/v1' });
await app.register(raidersRoutes, { prefix: '/v1' });
await app.register(guildsRoutes, { prefix: '/v1' });
await app.register(punishmentsRoutes, { prefix: '/v1' });
await app.register(quotaRoutes, { prefix: '/v1' });
await app.register(notesRoutes, { prefix: '/v1' });
await app.register(verificationRoutes, { prefix: '/v1' });
await app.register(commandLogRoutes, { prefix: '/v1' });
await app.register(modmailRoutes, { prefix: '/v1' });

app.listen({ port: backendConfig.PORT, host: '0.0.0.0' })
    .then(addr => app.log.info(`Backend listening on ${addr}`))
    .catch(err => { app.log.error(err); process.exit(1); });
