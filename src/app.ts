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

// ─── Admin Panel ─────────────────────────────────────────────────────────────

app.get('/admin', async (_req, reply) => {
  reply.type('text/html');
  return reply.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Notice Watch — Admin</title>
<style>
*{box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:20px}
h1{color:#f8fafc;margin:0 0 4px}
.sub{color:#94a3b8;font-size:.85rem;margin-bottom:24px}
.card{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:20px;margin-bottom:16px}
.card h2{margin:0 0 14px;font-size:1rem;color:#93c5fd}
label{display:block;font-size:.8rem;color:#94a3b8;margin-bottom:4px;margin-top:10px}
input,textarea{width:100%;padding:8px 10px;background:#0f172a;border:1px solid #334155;border-radius:6px;color:#f1f5f9;font-size:.9rem}
textarea{resize:vertical;min-height:60px}
button{margin-top:12px;padding:8px 18px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:.9rem}
button:hover{background:#1d4ed8}
button.red{background:#dc2626}button.red:hover{background:#b91c1c}
.res{margin-top:10px;padding:10px;background:#0f172a;border-radius:6px;font-size:.8rem;color:#86efac;white-space:pre-wrap;display:none}
.res.err{color:#fca5a5}
.stats-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.stat{background:#0f172a;border-radius:8px;padding:14px;text-align:center}
.stat .n{font-size:1.8rem;font-weight:700;color:#f8fafc}
.stat .l{font-size:.75rem;color:#94a3b8;margin-top:2px}
#token-bar{display:flex;gap:8px;align-items:center;margin-bottom:20px}
#token-bar input{max-width:340px}
</style>
</head>
<body>
<h1>Notice Watch Admin</h1>
<div class="sub">All requests use ADMIN_TOKEN. Set token once, persists in sessionStorage.</div>

<div id="token-bar">
  <input id="tok" type="password" placeholder="ADMIN_TOKEN" oninput="saveTok(this.value)">
  <button onclick="loadStats()">Load Stats</button>
</div>

<!-- Stats -->
<div class="card">
  <h2>Stats</h2>
  <div class="stats-grid" id="stats">
    <div class="stat"><div class="n" id="s-users">—</div><div class="l">Users</div></div>
    <div class="stat"><div class="n" id="s-devices">—</div><div class="l">Devices</div></div>
    <div class="stat"><div class="n" id="s-trackers">—</div><div class="l">Active Trackers</div></div>
    <div class="stat"><div class="n" id="s-notices">—</div><div class="l">Notices</div></div>
  </div>
</div>

<!-- Notify user -->
<div class="card">
  <h2>Send Notification to User</h2>
  <label>UID</label><input id="n-uid" placeholder="Firebase UID">
  <label>Title</label><input id="n-title" placeholder="New Notice Found">
  <label>Body</label><input id="n-body" placeholder="Notification body text">
  <label>Extra data (JSON, optional)</label><textarea id="n-data" placeholder='{"trackerId":"abc"}'></textarea>
  <button onclick="sendNotify()">Send</button>
  <div class="res" id="n-res"></div>
</div>

<!-- Broadcast -->
<div class="card">
  <h2>Broadcast to All Users</h2>
  <label>Title</label><input id="b-title" placeholder="Announcement">
  <label>Body</label><input id="b-body" placeholder="Message body">
  <label>Extra data (JSON, optional)</label><textarea id="b-data" placeholder='{}'></textarea>
  <button class="red" onclick="sendBroadcast()">Broadcast</button>
  <div class="res" id="b-res"></div>
</div>

<script>
const BASE = '';
function tok(){ return document.getElementById('tok').value; }
function saveTok(v){ sessionStorage.setItem('admin_tok',v); }
function show(id,obj,isErr){
  const el=document.getElementById(id);
  el.style.display='block';
  el.className='res'+(isErr?' err':'');
  el.textContent=JSON.stringify(obj,null,2);
}

window.onload = () => {
  const t = sessionStorage.getItem('admin_tok');
  if(t){ document.getElementById('tok').value = t; loadStats(); }
};

async function api(path, method='GET', body=null){
  const opts = { method, headers: { Authorization: 'Bearer '+tok(), 'Content-Type':'application/json' } };
  if(body) opts.body = JSON.stringify(body);
  const r = await fetch(BASE+path, opts);
  return { ok: r.ok, data: await r.json() };
}

async function loadStats(){
  const {ok,data} = await api('/api/admin/stats');
  if(!ok) return;
  document.getElementById('s-users').textContent = data.users;
  document.getElementById('s-devices').textContent = data.devices;
  document.getElementById('s-trackers').textContent = data.activeTrackers;
  document.getElementById('s-notices').textContent = data.notices;
}

async function sendNotify(){
  let extra = {};
  try{ extra = JSON.parse(document.getElementById('n-data').value||'{}'); }catch(e){ return alert('Invalid JSON in data field'); }
  const {ok,data} = await api('/api/admin/notify','POST',{
    uid: document.getElementById('n-uid').value,
    title: document.getElementById('n-title').value,
    body: document.getElementById('n-body').value,
    data: extra,
  });
  show('n-res',data,!ok);
}

async function sendBroadcast(){
  if(!confirm('Broadcast to ALL users?')) return;
  let extra = {};
  try{ extra = JSON.parse(document.getElementById('b-data').value||'{}'); }catch(e){ return alert('Invalid JSON in data field'); }
  const {ok,data} = await api('/api/admin/broadcast','POST',{
    title: document.getElementById('b-title').value,
    body: document.getElementById('b-body').value,
    data: extra,
  });
  show('b-res',data,!ok);
}
</script>
</body></html>`);
});

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
