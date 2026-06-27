import { trackersCol } from '../services/firestore.js';
import { urlHash } from '../utils/hash.js';
import { scraperQueue } from '../workers/scraper.worker.js';

const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

async function enqueueAllActiveTrackers(): Promise<void> {
  console.log('[Scheduler] Starting scheduled scrape cycle...');

  try {
    const snap = await trackersCol().where('active', '==', true).get();
    const trackers = snap.docs.map((doc) => doc.data());

    console.log(`[Scheduler] Found ${trackers.length} active trackers`);
    if (trackers.length === 0) return;

    // Deduplicate by sourceId — one job per unique URL regardless of how many trackers share it
    const sourceIds = new Set<string>();
    for (const tracker of trackers) {
      // Graceful fallback for trackers created before sourceId field was added
      sourceIds.add(tracker.sourceId ?? urlHash(tracker.url));
    }

    const cycleBucket = Math.floor(Date.now() / INTERVAL_MS);

    const jobs = [...sourceIds].map((sourceId) => ({
      name: 'scrape' as Parameters<typeof scraperQueue.add>[0],
      data: { sourceId },
      opts: {
        jobId: `cron-${sourceId}-${cycleBucket}`,
        attempts: 3,
        backoff: { type: 'exponential' as const, delay: 5000 },
      },
    }));

    await scraperQueue.addBulk(jobs);

    console.log(
      `[Scheduler] Enqueued ${jobs.length} source jobs for ${trackers.length} trackers`,
    );
  } catch (err) {
    console.error('[Scheduler] Failed to enqueue jobs:', err);
  }
}

export function startScheduler(): void {
  setInterval(() => { void enqueueAllActiveTrackers(); }, INTERVAL_MS);
  console.log(`[Scheduler] Started — running every ${INTERVAL_MS / 3600000}h via setInterval`);
}
