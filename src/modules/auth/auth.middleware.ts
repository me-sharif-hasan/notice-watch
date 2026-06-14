import { FastifyRequest, FastifyReply } from 'fastify';
import { admin } from '../../services/firestore.js';
import type { AuthenticatedUser } from '../../types/index.js';

// Augment Fastify's request type to carry the decoded user
declare module 'fastify' {
  interface FastifyRequest {
    user: AuthenticatedUser;
  }
}

/**
 * Fastify preHandler hook that verifies a Firebase ID token.
 *
 * Expects the request to include:
 *   Authorization: Bearer <firebase-id-token>
 *
 * On success, attaches `request.user = { uid, email }`.
 * On failure, replies with 401.
 */
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

  const token = authHeader.slice(7); // Remove "Bearer " prefix

  try {
    const decoded = await admin.auth().verifyIdToken(token);

    request.user = {
      uid: decoded.uid,
      email: decoded.email ?? '',
    };
  } catch (err) {
    console.warn('[Auth] Token verification failed:', (err as Error).message);
    return reply.status(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Invalid or expired token',
    });
  }
}
