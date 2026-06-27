import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { Timestamp } from 'firebase-admin/firestore';
import { requireAdmin } from './admin.middleware.js';
import { settingsDoc, integrationTokensCol, getDb } from '../../services/firestore.js';
import { sendToUser } from '../../services/fcm.js';

const settingsSchema = z.object({
  requireIntegrationToken: z.boolean().optional(),
});

const notifySchema = z.object({
  uid: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  data: z.record(z.string()).optional().default({}),
});

const broadcastSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  data: z.record(z.string()).optional().default({}),
});

const createTokenSchema = z.object({
  label: z.string().min(1).max(100),
});

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin);

  // ── GET /api/admin/settings ─────────────────────────────────────────────────
  app.get('/settings', async (_request: FastifyRequest, reply: FastifyReply) => {
    const snap = await settingsDoc().get();
    const settings = snap.exists ? snap.data() : { requireIntegrationToken: false };
    return reply.send({ settings });
  });

  // ── PATCH /api/admin/settings ───────────────────────────────────────────────
  app.patch('/settings', async (request: FastifyRequest, reply: FastifyReply) => {
    const result = settingsSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: result.error.errors.map((e) => e.message).join(', '),
      });
    }

    await settingsDoc().set(result.data as { requireIntegrationToken: boolean }, { merge: true });
    return reply.send({ settings: result.data });
  });

  // ── GET /api/admin/tokens ───────────────────────────────────────────────────
  app.get('/tokens', async (_request: FastifyRequest, reply: FastifyReply) => {
    const snap = await integrationTokensCol().get();
    const tokens = snap.docs.map((d) => d.data());
    return reply.send({ tokens });
  });

  // ── POST /api/admin/tokens ──────────────────────────────────────────────────
  app.post('/tokens', async (request: FastifyRequest, reply: FastifyReply) => {
    const result = createTokenSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: result.error.errors.map((e) => e.message).join(', '),
      });
    }

    const token = randomUUID();
    const doc = {
      token,
      label: result.data.label,
      active: true,
      createdAt: Timestamp.now(),
    };

    await integrationTokensCol().doc(token).set(doc);
    return reply.status(201).send({ token: doc });
  });

  // ── DELETE /api/admin/tokens/:token ────────────────────────────────────────
  app.delete('/tokens/:token', async (request: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) => {
    const ref = integrationTokensCol().doc(request.params.token);
    const snap = await ref.get();

    if (!snap.exists) {
      return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Token not found' });
    }

    await ref.update({ active: false });
    return reply.status(204).send();
  });

  // ── POST /api/admin/notify ─────────────────────────────────────────────────
  // Send push notification to a specific user
  app.post('/notify', async (request: FastifyRequest, reply: FastifyReply) => {
    const result = notifySchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({ statusCode: 400, error: 'Bad Request', message: result.error.errors.map((e) => e.message).join(', ') });
    }
    const { uid, title, body, data } = result.data;
    const outcome = await sendToUser(uid, title, body, data);
    return reply.send({ ...outcome, uid });
  });

  // ── POST /api/admin/broadcast ──────────────────────────────────────────────
  // Send push notification to ALL registered devices
  app.post('/broadcast', async (request: FastifyRequest, reply: FastifyReply) => {
    const result = broadcastSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({ statusCode: 400, error: 'Bad Request', message: result.error.errors.map((e) => e.message).join(', ') });
    }
    const { title, body, data } = result.data;

    const snap = await getDb().collection('devices').get();
    const uids = [...new Set(snap.docs.map((d) => d.data()['uid'] as string).filter(Boolean))];

    let successCount = 0;
    let failureCount = 0;

    await Promise.all(uids.map(async (uid) => {
      try {
        const r = await sendToUser(uid, title, body, data);
        successCount += r.successCount;
        failureCount += r.failureCount;
      } catch {
        failureCount++;
      }
    }));

    return reply.send({ userCount: uids.length, successCount, failureCount });
  });

  // ── GET /api/admin/stats ───────────────────────────────────────────────────
  app.get('/stats', async (_request: FastifyRequest, reply: FastifyReply) => {
    const [users, devices, trackers, notices] = await Promise.all([
      getDb().collection('users').count().get(),
      getDb().collection('devices').count().get(),
      getDb().collection('trackers').where('active', '==', true).count().get(),
      getDb().collection('notices').count().get(),
    ]);
    return reply.send({
      users: users.data().count,
      devices: devices.data().count,
      activeTrackers: trackers.data().count,
      notices: notices.data().count,
    });
  });
}
