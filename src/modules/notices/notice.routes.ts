import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { verifyFirebaseToken } from '../auth/auth.middleware.js';
import { getNotices, markNoticeAsRead } from './notice.service.js';

// ─── Validation ───────────────────────────────────────────────────────────────

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  startAfter: z.string().optional(),
});

// ─── Route Registration ───────────────────────────────────────────────────────

export async function noticeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', verifyFirebaseToken);

  // ── GET /api/notices/:trackerId ─────────────────────────────────────────────
  app.get(
    '/:trackerId',
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
}
