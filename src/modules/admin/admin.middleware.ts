import { FastifyRequest, FastifyReply } from 'fastify';
import { admin } from '../../services/firestore.js';

export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Missing token' });
  }

  const token = authHeader.slice(7);

  // Static master key — avoids Firebase JWT round-trip for Postman/admin panel
  const adminToken = process.env.ADMIN_TOKEN;
  if (adminToken && token === adminToken) return;

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    if (!decoded.admin) {
      return reply.status(403).send({ statusCode: 403, error: 'Forbidden', message: 'Admin access required' });
    }
  } catch {
    return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Invalid token' });
  }
}
