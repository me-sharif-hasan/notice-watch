import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { verifyFirebaseToken } from '../auth/auth.middleware.js';
import {
  createTracker,
  listTrackers,
  getTracker,
  deleteTracker,
  toggleTracker,
  updateTracker,
  manualScrape,
} from './tracker.service.js';

// ─── Validation Schemas ───────────────────────────────────────────────────────

const createTrackerSchema = z.object({
  url: z.string().url('Must be a valid URL'),
  prompt: z.string().min(5, 'Prompt must be at least 5 characters').max(500),
  global: z.boolean().optional().default(false),
  integrityToken: z.string().optional(),
});

const updateTrackerSchema = z.object({
  prompt: z.string().min(5).max(500).optional(),
  global: z.boolean().optional(),
});

// ─── Route Registration ───────────────────────────────────────────────────────

export async function trackerRoutes(app: FastifyInstance): Promise<void> {
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
      const tracker = await createTracker(
        request.user.uid,
        result.data.url,
        result.data.prompt,
        result.data.global,
        request.user.anonymous,
        result.data.integrityToken,
      );
      return reply.status(201).send({ id: tracker.id, tracker });
    } catch (err) {
      const message = (err as Error).message;
      if (message === 'TRACKER_LIMIT_REACHED') {
        return reply.status(403).send({ statusCode: 403, error: 'Forbidden', message: 'Tracker limit reached. Watch an ad to earn coins or subscribe for more.' });
      }
      if (message === 'INTEGRITY_TOKEN_REQUIRED') {
        return reply.status(400).send({ statusCode: 400, error: 'Bad Request', message: 'Integration token required.' });
      }
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
  app.get('/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const tracker = await getTracker(request.user.uid, request.params.id);
    if (!tracker) {
      return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Tracker not found' });
    }
    return reply.send({ tracker });
  });

  // ── PUT /api/trackers/:id ───────────────────────────────────────────────────
  app.put('/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const result = updateTrackerSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: result.error.errors.map((e) => e.message).join(', '),
      });
    }

    const tracker = await updateTracker(request.user.uid, request.params.id, result.data);
    if (!tracker) {
      return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Tracker not found' });
    }
    return reply.send({ tracker });
  });

  // ── DELETE /api/trackers/:id ────────────────────────────────────────────────
  app.delete('/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const deleted = await deleteTracker(request.user.uid, request.params.id);
    if (!deleted) {
      return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Tracker not found' });
    }
    return reply.status(204).send();
  });

  // ── PATCH /api/trackers/:id ─────────────────────────────────────────────────
  app.patch('/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      const newActive = await toggleTracker(request.user.uid, request.params.id);
      if (newActive === null) {
        return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Tracker not found' });
      }
      return reply.send({ active: newActive });
    } catch (err) {
      if ((err as Error).message === 'TRACKER_LIMIT_REACHED') {
        return reply.status(403).send({ statusCode: 403, error: 'Forbidden', message: 'Tracker limit reached.' });
      }
      throw err;
    }
  });

  // ── POST /api/trackers/:id/scrape ───────────────────────────────────────────
  app.post('/:id/scrape', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      await manualScrape(request.user.uid, request.params.id);
      return reply.status(202).send({ message: 'Scrape job enqueued' });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === 'SCRAPE_COOLDOWN') {
        return reply.status(429).send({ statusCode: 429, error: 'Too Many Requests', message: 'Manual scrape allowed once every 30 minutes.' });
      }
      if (msg === 'Tracker not found') return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: msg });
      if (msg === 'Not authorized') return reply.status(403).send({ statusCode: 403, error: 'Forbidden', message: msg });
      throw err;
    }
  });
}
