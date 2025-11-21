import 'dotenv/config';
import Fastify from 'fastify';
import { backendConfig } from './config.js';
import authPlugin from './plugins/auth.js';
import healthRoutes from './routes/system/health.js';
import runsRoutes from './routes/raid/runs.js';
import raidersRoutes from './routes/raid/raiders.js';
import syncRoutes from './routes/raid/sync.js';
import guildsRoutes from './routes/admin/guilds.js';
import punishmentsRoutes from './routes/moderation/punishments.js';
import quotaRoutes from './routes/raid/quota.js';
import notesRoutes from './routes/moderation/notes.js';
import verificationRoutes from './routes/system/verification.js';
import commandLogRoutes from './routes/admin/command-log.js';
import modmailRoutes from './routes/moderation/modmail.js';

const app = Fastify({ logger: true });

await app.register(authPlugin);
await app.register(healthRoutes, { prefix: '/v1' });
await app.register(runsRoutes, { prefix: '/v1' });
await app.register(raidersRoutes, { prefix: '/v1' });
await app.register(syncRoutes, { prefix: '/v1' });
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
