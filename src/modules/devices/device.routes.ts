import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { verifyFirebaseToken } from '../auth/auth.middleware.js';
import { registerDevice, unregisterDevice, listDevices } from './device.service.js';

// ─── Validation ───────────────────────────────────────────────────────────────

const registerDeviceSchema = z.object({
  fcmToken: z.string().min(10, 'Invalid FCM token'),
  platform: z.enum(['ios', 'android', 'web']).optional(),
});

// ─── Route Registration ───────────────────────────────────────────────────────

export async function deviceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', verifyFirebaseToken);

  // ── POST /api/devices ───────────────────────────────────────────────────────
  app.post('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const result = registerDeviceSchema.safeParse(request.body);

    if (!result.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: result.error.errors.map((e) => e.message).join(', '),
      });
    }

    const device = await registerDevice(
      request.user.uid,
      result.data.fcmToken,
      result.data.platform ?? 'unknown',
    );

    return reply.status(201).send({ id: device.id });
  });

  // ── GET /api/devices ────────────────────────────────────────────────────────
  app.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const devices = await listDevices(request.user.uid);
    return reply.send({ devices });
  });

  // ── DELETE /api/devices/:deviceId ───────────────────────────────────────────
  app.delete(
    '/:deviceId',
    async (
      request: FastifyRequest<{ Params: { deviceId: string } }>,
      reply: FastifyReply,
    ) => {
      const deleted = await unregisterDevice(request.user.uid, request.params.deviceId);

      if (!deleted) {
        return reply
          .status(404)
          .send({ statusCode: 404, error: 'Not Found', message: 'Device not found' });
      }

      return reply.status(204).send();
    },
  );
}
