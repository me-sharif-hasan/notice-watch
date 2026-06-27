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

// Convert Firestore Timestamps to ISO strings in every response
app.addHook('preSerialization', async (_request, _reply, payload) => {
  return JSON.parse(JSON.stringify(payload, (_key, value) => {
    if (
      value !== null &&
      typeof value === 'object' &&
      typeof value._seconds === 'number' &&
      typeof value._nanoseconds === 'number'
    ) {
      return new Date(value._seconds * 1000 + value._nanoseconds / 1e6).toISOString();
    }
    return value;
  }));
});

// Allow empty JSON bodies (e.g. PATCH /read with no payload)
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  if (!body || (body as string).trim() === '') {
    done(null, {});
    return;
  }
  try {
    done(null, JSON.parse(body as string));
  } catch (e) {
    done(e as Error, undefined);
  }
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

// ─── Privacy Policy ───────────────────────────────────────────────────────────

app.get('/privacy', async (_req, reply) => {
  reply.type('text/html');
  return reply.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Privacy Policy — Notice Watch</title>
<style>body{font-family:sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.6;color:#333}h1{color:#111}h2{margin-top:2em}a{color:#1a73e8}</style>
</head>
<body>
<h1>Privacy Policy</h1>
<p><em>Last updated: June 2026</em></p>

<h2>1. What We Collect</h2>
<ul>
  <li><strong>Account data:</strong> Firebase UID, email address (if signed in with Google)</li>
  <li><strong>Tracker URLs and prompts</strong> you create</li>
  <li><strong>FCM device token</strong> for push notifications</li>
  <li><strong>Usage data:</strong> coin balance, subscription status, tracker activity</li>
</ul>

<h2>2. How We Use It</h2>
<ul>
  <li>To scrape and deliver notices from URLs you track</li>
  <li>To send push notifications when new notices are found</li>
  <li>To manage your subscription and coin balance</li>
</ul>

<h2>3. Data Sharing</h2>
<p>We do not sell your data. We use the following third-party services:</p>
<ul>
  <li><strong>Firebase (Google):</strong> Authentication, database, push notifications</li>
  <li><strong>DeepSeek AI:</strong> Notice extraction from web pages (URL content only, no personal data)</li>
  <li><strong>Google AdMob:</strong> Rewarded ads</li>
  <li><strong>Google Play:</strong> Subscription billing</li>
</ul>

<h2>4. Public Trackers</h2>
<p>If you create a tracker without signing in, or enable the "Public" flag, notices from that tracker are visible to all users of the app. Do not track private or sensitive URLs publicly.</p>

<h2>5. Data Retention</h2>
<p>Your data is retained until you delete your account. On account deletion, your profile, trackers, and device tokens are deactivated. Notices are retained in anonymized form.</p>

<h2>6. Your Rights</h2>
<p>You may delete your account at any time via the app (Account → Delete Account). For data requests, contact us at <a href="mailto:me.sharif.hasan@gmail.com">me.sharif.hasan@gmail.com</a>.</p>

<h2>7. Contact</h2>
<p><a href="mailto:me.sharif.hasan@gmail.com">me.sharif.hasan@gmail.com</a></p>
</body></html>`);
});

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
