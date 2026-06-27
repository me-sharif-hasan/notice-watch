import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Timestamp } from 'firebase-admin/firestore';
import { verifyFirebaseToken } from './auth.middleware.js';
import { createOrGetUser, getMe } from './auth.service.js';
import { usersCol, trackersCol, devicesCol, getDb } from '../../services/firestore.js';

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
        email: request.user.email,
        anonymous: request.user.anonymous,
        subscribed: user.subscribed,
        subscribedUntil: user.subscribedUntil,
        coins: user.coins,
        trackerCount: user.trackerCount,
        trackerLimit,
        createdAt: user.createdAt,
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
          email: request.user.email,
          anonymous: request.user.anonymous,
          subscribed: user.subscribed,
          subscribedUntil: user.subscribedUntil,
          coins: user.coins,
          trackerCount: user.trackerCount,
          trackerLimit,
          createdAt: user.createdAt,
        });
      }
      throw err;
    }
  });

  // ── DELETE /api/me ───────────────────────────────────────────────────────────
  app.delete('/me', { preHandler: verifyFirebaseToken }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { uid } = request.user;
    const db = getDb();
    const batch = db.batch();

    // Soft-delete user doc
    const userRef = usersCol().doc(uid);
    const userSnap = await userRef.get();
    if (userSnap.exists) {
      batch.update(userRef, { deleted: true, deletedAt: Timestamp.now() });
    }

    // Deactivate all trackers
    const trackerSnap = await trackersCol().where('uid', '==', uid).get();
    for (const doc of trackerSnap.docs) {
      batch.update(doc.ref, { active: false });
    }

    // Delete all device tokens
    const deviceSnap = await devicesCol().where('uid', '==', uid).get();
    for (const doc of deviceSnap.docs) {
      batch.delete(doc.ref);
    }

    await batch.commit();
    return reply.status(204).send();
  });
}
