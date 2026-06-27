import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { verifyFirebaseToken } from '../auth/auth.middleware.js';
import {
  getNotices,
  getMyNotices,
  getGlobalNotices,
  getNoticeById,
  markNoticeAsRead,
  markAllRead,
} from './notice.service.js';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  startAfter: z.string().optional(),
  mode: z.enum(['mine', 'global']).optional().default('mine'),
});

export async function noticeRoutes(app: FastifyInstance): Promise<void> {

  // ── GET /api/notices — cross-tracker feed ───────────────────────────────────
  // mode=global: no auth required; mode=mine: auth required
  app.get(
    '/',
    {
      config: {
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
    },
    async (
      request: FastifyRequest<{ Querystring: { limit?: string; startAfter?: string; mode?: string } }>,
      reply: FastifyReply,
    ) => {
      const queryResult = querySchema.safeParse(request.query);
      if (!queryResult.success) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: queryResult.error.errors.map((e) => e.message).join(', '),
        });
      }

      const { limit, startAfter, mode } = queryResult.data;

      if (mode === 'global') {
        const { notices, hasMore } = await getGlobalNotices({ limit, startAfter });
        return reply.send({
          notices,
          pagination: { hasMore, nextCursor: hasMore ? notices[notices.length - 1]?.id : null },
        });
      }

      // mode=mine — requires auth
      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Authentication required for mode=mine' });
      }

      try {
        await verifyFirebaseToken(request, reply);
      } catch {
        return;
      }

      const { notices, hasMore } = await getMyNotices(request.user.uid, { limit, startAfter });
      return reply.send({
        notices,
        pagination: { hasMore, nextCursor: hasMore ? notices[notices.length - 1]?.id : null },
      });
    },
  );

  // ── GET /api/notices/single/:noticeId ───────────────────────────────────────
  app.get(
    '/single/:noticeId',
    { preHandler: verifyFirebaseToken },
    async (
      request: FastifyRequest<{ Params: { noticeId: string } }>,
      reply: FastifyReply,
    ) => {
      const notice = await getNoticeById(request.user.uid, request.params.noticeId);
      if (!notice) {
        return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Notice not found' });
      }
      return reply.send({ notice });
    },
  );

  // ── GET /api/notices/:trackerId ─────────────────────────────────────────────
  app.get(
    '/:trackerId',
    { preHandler: verifyFirebaseToken },
    async (
      request: FastifyRequest<{
        Params: { trackerId: string };
        Querystring: { limit?: string; startAfter?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const queryResult = querySchema.safeParse(request.query);
      if (!queryResult.success) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: queryResult.error.errors.map((e) => e.message).join(', '),
        });
      }

      const { notices, hasMore } = await getNotices(
        request.user.uid,
        request.params.trackerId,
        queryResult.data,
      );

      return reply.send({
        notices,
        pagination: {
          hasMore,
          nextCursor: hasMore ? notices[notices.length - 1]?.id : null,
        },
      });
    },
  );

  // ── PATCH /api/notices/:noticeId/read ───────────────────────────────────────
  app.patch(
    '/:noticeId/read',
    { preHandler: verifyFirebaseToken },
    async (
      request: FastifyRequest<{ Params: { noticeId: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        await markNoticeAsRead(request.user.uid, request.params.noticeId);
        return reply.status(204).send();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        const status = msg === 'Notice not found' ? 404 : msg === 'Not authorized' ? 403 : 500;
        return reply.status(status).send({ statusCode: status, message: msg });
      }
    },
  );

  // ── PATCH /api/notices/:trackerId/read-all ──────────────────────────────────
  app.patch(
    '/:trackerId/read-all',
    { preHandler: verifyFirebaseToken },
    async (
      request: FastifyRequest<{ Params: { trackerId: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        await markAllRead(request.user.uid, request.params.trackerId);
        return reply.status(204).send();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        return reply.status(403).send({ statusCode: 403, message: msg });
      }
    },
  );
}
