import { FastifyRequest, FastifyReply } from 'fastify';
import { admin } from '../../services/firestore.js';
import { getRedis } from '../../services/redis.js';
import { createOrGetUser } from './auth.service.js';
import type { AuthenticatedUser } from '../../types/index.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthenticatedUser;
  }
}

export async function verifyFirebaseToken(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.status(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Missing or malformed Authorization header',
    });
  }

  const token = authHeader.slice(7);

  try {
    const cacheKey = `tok:${token.slice(-32)}`;
    const redis = getRedis();
    let uid: string, email: string | null, anonymous: boolean;

    const cached = await redis.get(cacheKey).catch(() => null);
    if (cached) {
      ({ uid, email, anonymous } = JSON.parse(cached) as AuthenticatedUser);
    } else {
      const decoded = await admin.auth().verifyIdToken(token);
      uid = decoded.uid;
      email = decoded.email ?? null;
      anonymous = decoded.firebase?.sign_in_provider === 'anonymous';

      // Cache until token expires (max 5min to limit stale window)
      const ttl = Math.min(Math.floor(decoded.exp - Date.now() / 1000), 300);
      if (ttl > 0) {
        await redis.set(cacheKey, JSON.stringify({ uid, email, anonymous }), 'EX', ttl).catch(() => null);
      }
    }

    request.user = { uid, email, anonymous };

    // Auto-create UserDoc on first authenticated request (fire-and-forget after cache hit)
    void createOrGetUser(uid, email, anonymous);
  } catch (err) {
    console.warn('[Auth] Token verification failed:', (err as Error).message);
    return reply.status(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Invalid or expired token',
    });
  }
}
