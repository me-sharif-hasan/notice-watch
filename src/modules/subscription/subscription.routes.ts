import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { verifyFirebaseToken } from '../auth/auth.middleware.js';
import { verifyGooglePlayPurchase, handleRtdnNotification } from './subscription.service.js';
import { usersCol } from '../../services/firestore.js';
import { cacheGet, CacheKey } from '../../services/cache.js';
import type { UserDoc } from '../../types/index.js';

const verifySchema = z.object({
  purchaseToken: z.string().min(1),
  productId: z.string().min(1),
});

export async function subscriptionRoutes(app: FastifyInstance): Promise<void> {

  // ── GET /api/subscription/status ───────────────────────────────────────────
  app.get('/status', { preHandler: verifyFirebaseToken }, async (request: FastifyRequest, reply: FastifyReply) => {
    const uid = request.user.uid;
    let user: UserDoc | null = await cacheGet<UserDoc>(CacheKey.user(uid));

    if (!user) {
      const snap = await usersCol().doc(uid).get();
      if (!snap.exists) {
        return reply.send({ subscribed: false, plan: null, subscribedUntil: null, platform: null });
      }
      user = snap.data() as UserDoc;
    }

    return reply.send({
      subscribed: user.subscribed,
      plan: user.subscribed ? 'notice_watch_premium' : null,
      subscribedUntil: user.subscribedUntil ?? null,
      platform: user.subscribed ? 'android' : null,
    });
  });

  // ── POST /api/subscription/verify ──────────────────────────────────────────
  app.post('/verify', { preHandler: verifyFirebaseToken }, async (request: FastifyRequest, reply: FastifyReply) => {
    const result = verifySchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: result.error.errors.map((e) => e.message).join(', '),
      });
    }

    try {
      await verifyGooglePlayPurchase(
        request.user.uid,
        result.data.purchaseToken,
        result.data.productId,
      );
      return reply.send({ subscribed: true });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === 'Subscription not active') {
        return reply.status(402).send({ statusCode: 402, error: 'Payment Required', message: msg });
      }
      throw err;
    }
  });

  // ── POST /api/subscription/rtdn-webhook ────────────────────────────────────
  // Called by Google Cloud Pub/Sub — no Firebase auth
  app.post('/rtdn-webhook', async (request: FastifyRequest, reply: FastifyReply) => {
    // Verify Pub/Sub push token
    const expectedToken = process.env.PUBSUB_VERIFICATION_TOKEN;
    const queryToken = (request.query as Record<string, string>).token;

    if (expectedToken && queryToken !== expectedToken) {
      console.warn('[RTDN] Invalid Pub/Sub verification token');
      return reply.status(200).send(); // 200 to prevent Pub/Sub retry spam on auth failures
    }

    try {
      const body = request.body as { message?: { data?: string } };
      const messageData = body?.message?.data;

      if (!messageData) {
        console.warn('[RTDN] No message data in Pub/Sub payload');
        return reply.status(200).send();
      }

      await handleRtdnNotification(messageData);
    } catch (err) {
      console.error('[RTDN] Error handling notification:', err);
    }

    // Always 200 — Pub/Sub retries on non-2xx
    return reply.status(200).send();
  });
}
