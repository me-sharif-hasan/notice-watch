import { Worker, Queue, QueueEvents } from 'bullmq';
import { Timestamp } from 'firebase-admin/firestore';
import { trackersCol, noticesCol, sourcesCol, getDb } from '../services/firestore.js';
import { renderPage } from '../services/playwright.js';
import { extractNotices } from '../services/deepseek.js';
import { sendToUser } from '../services/fcm.js';
import { htmlToMarkdown, truncate } from '../utils/markdown.js';
import { contentHash, noticeHash } from '../utils/hash.js';
import type { ScraperJobData, TrackerDoc, NoticeDoc, SourceDoc } from '../types/index.js';

// ─── Redis Connection ─────────────────────────────────────────────────────────

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

// ─── Queue Events ─────────────────────────────────────────────────────────────

export const scraperQueueEvents = new QueueEvents('scraper-queue', {
  connection: makeConnection(),
});

scraperQueueEvents.on('completed', ({ jobId }) => {
  console.log(`[Queue] Job ${jobId} completed`);
});

scraperQueueEvents.on('failed', ({ jobId, failedReason }) => {
  console.error(`[Queue] Job ${jobId} failed: ${failedReason}`);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveLink(link: string | null, base: string): string {
  if (!link) return '';
  try {
    return new URL(link, base).href;
  } catch {
    return link;
  }
}

const MAX_MARKDOWN_CHARS = parseInt(process.env.MAX_MARKDOWN_CHARS ?? '50000', 10);

// ─── Worker Process ───────────────────────────────────────────────────────────

/**
 * Processes a single scraper job per source (unique URL):
 *
 * 1. Fetch source doc
 * 2. Find all active trackers pointing at this source
 * 3. Render page once with Playwright
 * 4. Hash content — skip DeepSeek if unchanged, just update lastCheckedAt on all trackers
 * 5. Group trackers by prompt — one DeepSeek call per unique prompt
 * 6. For each tracker: store new notices (atomic create), send FCM
 * 7. Update source metadata
 */
async function processJob(data: ScraperJobData): Promise<void> {
  const { sourceId } = data;

  console.log(`[Worker] Processing source ${sourceId}`);

  // ── 1. Fetch source ─────────────────────────────────────────────────────────
  const sourceRef = sourcesCol().doc(sourceId);
  const sourceSnap = await sourceRef.get();

  if (!sourceSnap.exists) {
    console.warn(`[Worker] Source ${sourceId} not found, skipping`);
    return;
  }

  const source = sourceSnap.data() as SourceDoc;

  // ── 2. Find active trackers for this source ─────────────────────────────────
  const trackerSnap = await trackersCol()
    .where('sourceId', '==', sourceId)
    .where('active', '==', true)
    .get();

  if (trackerSnap.empty) {
    console.log(`[Worker] No active trackers for source ${sourceId}, skipping`);
    return;
  }

  const trackers = trackerSnap.docs.map((d) => d.data() as TrackerDoc);
  console.log(`[Worker] ${trackers.length} active tracker(s) for source ${sourceId}`);

  // ── 3. Render page once ─────────────────────────────────────────────────────
  let html: string;
  try {
    html = await renderPage(source.url);
  } catch (err) {
    console.error(`[Worker] Playwright failed for ${source.url}:`, err);
    throw err;
  }

  const markdown = truncate(htmlToMarkdown(html), MAX_MARKDOWN_CHARS);

  // ── 4. Content hash check ───────────────────────────────────────────────────
  const newContentHash = contentHash(markdown);

  if (source.lastContentHash === newContentHash) {
    console.log(`[Worker] Content unchanged for source ${sourceId}, updating lastCheckedAt`);
    const batch = getDb().batch();
    for (const tracker of trackers) {
      batch.update(trackersCol().doc(tracker.id), { lastCheckedAt: Timestamp.now() });
    }
    await batch.commit();
    return;
  }

  console.log(`[Worker] Content changed for source ${sourceId}, calling DeepSeek`);

  // ── 5. Group trackers by prompt (one DeepSeek call per unique prompt) ────────
  const byPrompt = new Map<string, TrackerDoc[]>();
  for (const tracker of trackers) {
    const group = byPrompt.get(tracker.prompt) ?? [];
    group.push(tracker);
    byPrompt.set(tracker.prompt, group);
  }

  // ── 6. Extract + fan out per prompt group ───────────────────────────────────
  const db = noticesCol();

  for (const [prompt, promptTrackers] of byPrompt) {
    let rawNotices;
    try {
      rawNotices = await extractNotices(markdown, prompt);
    } catch (err) {
      console.error(`[Worker] DeepSeek failed for source ${sourceId}:`, err);
      throw err;
    }

    console.log(
      `[Worker] DeepSeek returned ${rawNotices.length} notices for prompt group (${promptTrackers.length} tracker(s))`,
    );

    for (const tracker of promptTrackers) {
      let newNoticeCount = 0;

      for (const raw of rawNotices) {
        const resolvedLink = resolveLink(raw.link, source.url);
        const hash = noticeHash(raw.title, resolvedLink, raw.date);
        const docId = `${tracker.id}_${hash}`;
        const noticeRef = db.doc(docId);

        const notice: NoticeDoc = {
          id: docId,
          trackerId: tracker.id,
          title: raw.title,
          summary: raw.summary,
          link: resolvedLink,
          noticeHash: hash,
          readAt: null,
          publishedDate: raw.date,
          createdAt: Timestamp.now(),
        };

        try {
          await noticeRef.create(notice); // atomic — throws code 6 if already exists
        } catch (err: unknown) {
          const code = (err as { code?: number })?.code;
          if (code === 6) {
            console.log(`[Worker] Notice already exists (hash=${hash}), skipping`);
            continue;
          }
          throw err;
        }

        newNoticeCount++;
        console.log(`[Worker] Stored notice: "${raw.title}" → tracker ${tracker.id}`);

        try {
          await sendToUser(tracker.uid, 'New Notice Found', raw.title, {
            trackerId: tracker.id,
            noticeId: docId,
          });
        } catch (err) {
          console.error(`[Worker] FCM failed for notice ${docId}:`, err);
        }
      }

      await trackersCol().doc(tracker.id).update({ lastCheckedAt: Timestamp.now() });

      console.log(
        `[Worker] Tracker ${tracker.id} done. New: ${newNoticeCount}/${rawNotices.length}`,
      );
    }
  }

  // ── 7. Update source metadata ───────────────────────────────────────────────
  await sourceRef.update({
    lastContentHash: newContentHash,
    lastRenderedAt: Timestamp.now(),
  });

  console.log(`[Worker] Source ${sourceId} done`);
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
