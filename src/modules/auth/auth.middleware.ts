import { FastifyRequest, FastifyReply } from 'fastify';
import { admin } from '../../services/firestore.js';
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
    const decoded = await admin.auth().verifyIdToken(token);
    const anonymous = decoded.firebase?.sign_in_provider === 'anonymous';

    request.user = {
      uid: decoded.uid,
      email: decoded.email ?? null,
      anonymous,
    };

    // Auto-create UserDoc on first authenticated request
    await createOrGetUser(decoded.uid, decoded.email ?? null, anonymous);
  } catch (err) {
    console.warn('[Auth] Token verification failed:', (err as Error).message);
    return reply.status(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Invalid or expired token',
    });
  }
}
