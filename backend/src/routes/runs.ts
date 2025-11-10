import { FastifyInstance } from 'fastify';
import { z } from 'zod';

const CreateRun = z.object({
    dungeon: z.string().min(1).max(100),
    desc: z.string().max(1000).optional(),
    organizerId: z.string().min(1) // discord user id
});

// in-memory store for now
let nextRunId = 1;
const runs = new Map<number, {
    id: number; dungeon: string; desc?: string;
    organizerId: string; createdAt: string;
}>();

export default async function routes(app: FastifyInstance) {
    app.post('/runs', async (req, reply) => {
        const parsed = CreateRun.safeParse(req.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
        }
        const { dungeon, desc, organizerId } = parsed.data;

        const runId = nextRunId++;
        const created = {
            id: runId,
            dungeon,
            desc,
            organizerId,
            createdAt: new Date().toISOString()
        };
        runs.set(runId, created);

        return reply.code(201).send({ runId });
    });
}
