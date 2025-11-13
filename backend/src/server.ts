import 'dotenv/config';
import Fastify from 'fastify';
import { backendConfig } from './config.js';
import authPlugin from './plugins/auth.js';
import healthRoutes from './routes/health.js';
import runsRoutes from './routes/runs.js';
import raidersRoutes from './routes/raiders.js';
import guildsRoutes from './routes/guilds.js';
import punishmentsRoutes from './routes/punishments.js';
import quotaRoutes from './routes/quota.js';
import notesRoutes from './routes/notes.js';
import verificationRoutes from './routes/verification.js';
import commandLogRoutes from './routes/command-log.js';

const app = Fastify({ logger: true });

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

app.listen({ port: backendConfig.PORT, host: '0.0.0.0' })
    .then(addr => app.log.info(`Backend listening on ${addr}`))
    .catch(err => { app.log.error(err); process.exit(1); });
