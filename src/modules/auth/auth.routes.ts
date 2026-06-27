import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { verifyFirebaseToken } from './auth.middleware.js';
import { createOrGetUser, getMe } from './auth.service.js';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /api/auth/register ─────────────────────────────────────────────────
  app.post('/auth/register', { preHandler: verifyFirebaseToken }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { uid, email, anonymous } = request.user;
    const user = await createOrGetUser(uid, email, anonymous);
    return reply.status(201).send({ user });
  });

  // ── GET /api/me ─────────────────────────────────────────────────────────────
  app.get('/me', { preHandler: verifyFirebaseToken }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { user, trackerLimit } = await getMe(request.user.uid);
      return reply.send({
        uid: user.uid,
        anonymous: user.anonymous,
        subscribed: user.subscribed,
        subscribedUntil: user.subscribedUntil,
        coins: user.coins,
        trackerCount: user.trackerCount,
        trackerLimit,
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === 'User not found') {
        // Auto-create if missing
        const { uid, email, anonymous } = request.user;
        await createOrGetUser(uid, email, anonymous);
        const { user, trackerLimit } = await getMe(uid);
        return reply.send({
          uid: user.uid,
          anonymous: user.anonymous,
          subscribed: user.subscribed,
          subscribedUntil: user.subscribedUntil,
          coins: user.coins,
          trackerCount: user.trackerCount,
          trackerLimit,
        });
      }
      throw err;
    }
  });
}
