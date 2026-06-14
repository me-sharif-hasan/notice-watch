import { Worker, Queue, QueueEvents } from 'bullmq';
import { Timestamp } from 'firebase-admin/firestore';
import { trackersCol, noticesCol } from '../services/firestore.js';
import { renderPage } from '../services/playwright.js';
import { extractNotices } from '../services/deepseek.js';
import { sendToUser } from '../services/fcm.js';
import { htmlToMarkdown, truncate } from '../utils/markdown.js';
import { contentHash, noticeHash } from '../utils/hash.js';
import type { ScraperJobData, TrackerDoc, NoticeDoc } from '../types/index.js';

// ─── Redis Connection Options ─────────────────────────────────────────────────
// BullMQ v5 bundles its own ioredis. Pass the URL string directly to avoid
// type conflicts between the two ioredis versions.

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

function makeConnection(): { url: string } {
  return { url: redisUrl };
}

// ─── Queue ────────────────────────────────────────────────────────────────────

export const scraperQueue = new Queue<ScraperJobData>('scraper-queue', {
  connection: makeConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 },
  },
});

// ─── Queue Events (for logging) ───────────────────────────────────────────────

export const scraperQueueEvents = new QueueEvents('scraper-queue', {
  connection: makeConnection(),
});

scraperQueueEvents.on('completed', ({ jobId }) => {
  console.log(`[Queue] Job ${jobId} completed`);
});

scraperQueueEvents.on('failed', ({ jobId, failedReason }) => {
  console.error(`[Queue] Job ${jobId} failed: ${failedReason}`);
});

// ─── Max Markdown Size ────────────────────────────────────────────────────────

const MAX_MARKDOWN_CHARS = parseInt(process.env.MAX_MARKDOWN_CHARS ?? '50000', 10);

// ─── Worker Process ───────────────────────────────────────────────────────────

/**
 * Processes a single scraper job:
 *
 * 1. Fetch tracker from Firestore
 * 2. Verify tracker is still active
 * 3. Render page with Playwright
 * 4. Convert HTML → Markdown → truncate
 * 5. Hash the Markdown — skip DeepSeek if content unchanged
 * 6. Call DeepSeek to extract notices
 * 7. For each notice: compute hash, skip if already stored, else store + notify
 * 8. Update tracker metadata
 */
async function processJob(data: ScraperJobData): Promise<void> {
  const { trackerId } = data;

  console.log(`[Worker] Processing tracker ${trackerId}`);

  // ── 1. Fetch tracker ────────────────────────────────────────────────────────
  const trackerRef = trackersCol().doc(trackerId);
  const trackerSnap = await trackerRef.get();

  if (!trackerSnap.exists) {
    console.warn(`[Worker] Tracker ${trackerId} not found, skipping`);
    return;
  }

  const tracker = trackerSnap.data() as TrackerDoc;

  // ── 2. Skip if deactivated ─────────────────────────────────────────────────
  if (!tracker.active) {
    console.log(`[Worker] Tracker ${trackerId} is inactive, skipping`);
    return;
  }

  // ── 3. Render page ─────────────────────────────────────────────────────────
  let html: string;
  try {
    html = await renderPage(tracker.url);
  } catch (err) {
    console.error(`[Worker] Playwright failed for ${tracker.url}:`, err);
    throw err; // Let BullMQ retry
  }

  // ── 4. Convert HTML → Markdown → truncate ──────────────────────────────────
  const markdown = truncate(htmlToMarkdown(html), MAX_MARKDOWN_CHARS);

  // ── 5. Content hash check ───────────────────────────────────────────────────
  const newContentHash = contentHash(markdown);

  if (tracker.lastContentHash === newContentHash) {
    console.log(`[Worker] Content unchanged for tracker ${trackerId}, updating lastCheckedAt`);
    await trackerRef.update({ lastCheckedAt: Timestamp.now() });
    return;
  }

  console.log(`[Worker] Content changed for tracker ${trackerId}, calling DeepSeek`);

  // ── 6. Extract notices via DeepSeek ─────────────────────────────────────────
  let rawNotices;
  try {
    rawNotices = await extractNotices(markdown, tracker.prompt);
  } catch (err) {
    console.error(`[Worker] DeepSeek extraction failed for tracker ${trackerId}:`, err);
    throw err; // Let BullMQ retry
  }

  console.log(`[Worker] DeepSeek returned ${rawNotices.length} notices for tracker ${trackerId}`);

  // ── 7. Process each notice ─────────────────────────────────────────────────
  const db = noticesCol();
  let newNoticeCount = 0;

  for (const raw of rawNotices) {
    const hash = noticeHash(raw.title, raw.date, raw.link ?? '');

    // Check if notice already stored (deduplication)
    const existing = await db
      .where('noticeHash', '==', hash)
      .where('trackerId', '==', trackerId)
      .limit(1)
      .get();

    if (!existing.empty) {
      console.log(`[Worker] Notice already exists (hash=${hash}), skipping`);
      continue;
    }

    // ── Store new notice ──────────────────────────────────────────────────────
    const noticeRef = db.doc();
    const notice: NoticeDoc = {
      id: noticeRef.id,
      trackerId,
      title: raw.title,
      summary: raw.summary,
      link: raw.link ?? '',
      noticeHash: hash,
      publishedDate: raw.date,
      createdAt: Timestamp.now(),
    };

    await noticeRef.set(notice);
    newNoticeCount++;

    console.log(`[Worker] Stored new notice: "${raw.title}" (${noticeRef.id})`);

    // ── Send FCM notification ─────────────────────────────────────────────────
    try {
      await sendToUser(tracker.uid, 'New Notice Found', raw.title, {
        trackerId,
        noticeId: noticeRef.id,
      });
    } catch (err) {
      // Notification failure should not block notice storage or other notices
      console.error(`[Worker] FCM send failed for notice ${noticeRef.id}:`, err);
    }
  }

  // ── 8. Update tracker metadata ─────────────────────────────────────────────
  await trackerRef.update({
    lastContentHash: newContentHash,
    lastCheckedAt: Timestamp.now(),
  });

  console.log(
    `[Worker] Tracker ${trackerId} done. New notices: ${newNoticeCount}/${rawNotices.length}`,
  );
}

// ─── Worker Instance ──────────────────────────────────────────────────────────

const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY ?? '2', 10);

export const scraperWorker = new Worker<ScraperJobData>(
  'scraper-queue',
  async (job) => {
    await processJob(job.data);
  },
  {
    connection: makeConnection(),
    concurrency: WORKER_CONCURRENCY,
  },
);

scraperWorker.on('error', (err) => {
  console.error('[Worker] Unhandled worker error:', err);
});
