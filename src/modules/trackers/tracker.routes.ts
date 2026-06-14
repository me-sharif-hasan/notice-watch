import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { verifyFirebaseToken } from '../auth/auth.middleware.js';
import {
  createTracker,
  listTrackers,
  getTracker,
  deleteTracker,
  toggleTracker,
} from './tracker.service.js';

// ─── Validation Schemas ───────────────────────────────────────────────────────

const createTrackerSchema = z.object({
  url: z.string().url('Must be a valid URL'),
  prompt: z.string().min(5, 'Prompt must be at least 5 characters').max(500),
});

// ─── Route Registration ───────────────────────────────────────────────────────

export async function trackerRoutes(app: FastifyInstance): Promise<void> {
  // All tracker routes require authentication
  app.addHook('preHandler', verifyFirebaseToken);

  // ── POST /api/trackers ──────────────────────────────────────────────────────
  app.post('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const result = createTrackerSchema.safeParse(request.body);

    if (!result.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: result.error.errors.map((e) => e.message).join(', '),
      });
    }

    try {
      const tracker = await createTracker(request.user.uid, result.data.url, result.data.prompt);
      return reply.status(201).send({ id: tracker.id, tracker });
    } catch (err) {
      const message = (err as Error).message;

      // SSRF / URL validation errors → 400
      if (message.includes('Invalid URL') || message.includes('not allowed') || message.includes('private')) {
        return reply.status(400).send({ statusCode: 400, error: 'Bad Request', message });
      }

      throw err;
    }
  });

  // ── GET /api/trackers ───────────────────────────────────────────────────────
  app.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const trackers = await listTrackers(request.user.uid);
    return reply.send({ trackers });
  });

  // ── GET /api/trackers/:id ───────────────────────────────────────────────────
  app.get(
    '/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const tracker = await getTracker(request.user.uid, request.params.id);

      if (!tracker) {
        return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Tracker not found' });
      }

      return reply.send({ tracker });
    },
  );

  // ── DELETE /api/trackers/:id ────────────────────────────────────────────────
  app.delete(
    '/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const deleted = await deleteTracker(request.user.uid, request.params.id);

      if (!deleted) {
        return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Tracker not found' });
      }

      return reply.status(204).send();
    },
  );

  // ── PATCH /api/trackers/:id ─────────────────────────────────────────────────
  app.patch(
    '/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const newActive = await toggleTracker(request.user.uid, request.params.id);

      if (newActive === null) {
        return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Tracker not found' });
      }

      return reply.send({ active: newActive });
    },
  );
}
