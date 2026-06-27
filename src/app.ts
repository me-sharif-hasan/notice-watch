import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticPlugin from '@fastify/static';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

import { trackerRoutes } from './modules/trackers/tracker.routes.js';
import { noticeRoutes } from './modules/notices/notice.routes.js';
import { deviceRoutes } from './modules/devices/device.routes.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { adRoutes } from './modules/ad/ad.routes.js';
import { subscriptionRoutes } from './modules/subscription/subscription.routes.js';
import { adminRoutes } from './modules/admin/admin.routes.js';
import { startScheduler } from './jobs/scheduler.js';
import { scraperWorker } from './workers/scraper.worker.js';
import { closeBrowser } from './services/playwright.js';

// ─── App Factory ──────────────────────────────────────────────────────────────

const app = Fastify({
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'warn' : 'info',
    transport:
      process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  },
});

// ─── Plugins ──────────────────────────────────────────────────────────────────

await app.register(helmet, {
  contentSecurityPolicy: false,   // Disabled so Firebase SDK + inline scripts load in the UI
  crossOriginEmbedderPolicy: false,
});

await app.register(cors, {
  origin: process.env.CORS_ORIGIN ?? '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
});

await app.register(rateLimit, {
  max: parseInt(process.env.RATE_LIMIT_MAX ?? '100', 10),
  timeWindow: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000', 10),
  errorResponseBuilder: () => ({
    statusCode: 429,
    error: 'Too Many Requests',
    message: 'Rate limit exceeded. Please slow down.',
  }),
});

// ─── Static UI ────────────────────────────────────────────────────────────────
// Serves test-ui/index.html at http://localhost:3000/ui

await app.register(staticPlugin, {
  root:        resolve(__dirname, '..', 'test-ui'),
  prefix:      '/ui',
  decorateReply: false,
});

// Redirect bare /ui to /ui/index.html
app.get('/ui', async (_req, reply) => reply.redirect('/ui/index.html'));

// Redirect root to /ui for browser access
app.get('/', async (_req, reply) => reply.redirect('/ui/index.html'));

// ─── Routes ───────────────────────────────────────────────────────────────────

await app.register(authRoutes, { prefix: '/api' });
await app.register(trackerRoutes, { prefix: '/api/trackers' });
await app.register(noticeRoutes, { prefix: '/api/notices' });
await app.register(deviceRoutes, { prefix: '/api/devices' });
await app.register(adRoutes, { prefix: '/api/ad' });
await app.register(subscriptionRoutes, { prefix: '/api/subscription' });
await app.register(adminRoutes, { prefix: '/api/admin' });

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get('/health', async () => ({
  status: 'ok',
  timestamp: new Date().toISOString(),
  uptime: process.uptime(),
}));

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  console.log(`\n[App] Received ${signal}, shutting down gracefully...`);

  try {
    await scraperWorker.close();
    console.log('[App] BullMQ worker closed');

    await closeBrowser();
    console.log('[App] Playwright browser closed');

    await app.close();
    console.log('[App] Fastify server closed');

    process.exit(0);
  } catch (err) {
    console.error('[App] Error during shutdown:', err);
    process.exit(1);
  }
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT',  () => { void shutdown('SIGINT');  });

// ─── Unhandled Rejection Guard ────────────────────────────────────────────────

process.on('unhandledRejection', (reason) => {
  console.error('[App] Unhandled promise rejection:', reason);
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? '3000', 10);

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`[App] Server running on port ${PORT}`);

  // Start background services
  startScheduler();
  console.log('[App] Scheduler started');
  console.log(`[App] Scraper worker running (concurrency=${process.env.WORKER_CONCURRENCY ?? '2'})`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
