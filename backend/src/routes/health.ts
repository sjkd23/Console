import { FastifyInstance } from 'fastify';

export default async function routes(app: FastifyInstance) {
    // Public health endpoint (no auth)
    app.route({
        method: 'GET',
        url: '/health',
        config: { public: true },
        handler: async () => ({
            ok: true,
            service: 'rotmg-raid-backend',
            time: new Date().toISOString()
        })
    });
}
