import { trackersCol } from '../services/firestore.js';
import { scraperQueue } from '../workers/scraper.worker.js';

const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

async function enqueueAllActiveTrackers(): Promise<void> {
  console.log('[Scheduler] Starting scheduled scrape cycle...');

  try {
    const snap = await trackersCol().where('active', '==', true).get();
    const trackers = snap.docs.map((doc) => doc.data());

    console.log(`[Scheduler] Found ${trackers.length} active trackers`);

    if (trackers.length === 0) return;

    // Use a time-bucketed jobId so deduplication only blocks duplicates within
    // the same 6-hour window, not across cycles. Completed jobs from a prior
    // cycle have a different bucket and won't block re-enqueue.
    const cycleBucket = Math.floor(Date.now() / INTERVAL_MS);

    const jobs = trackers.map((tracker) => ({
      name: 'scrape' as Parameters<typeof scraperQueue.add>[0],
      data: { trackerId: tracker.id },
      opts: {
        jobId: `cron-${tracker.id}-${cycleBucket}`,
        attempts: 3,
        backoff: { type: 'exponential' as const, delay: 5000 },
      },
    }));

    await scraperQueue.addBulk(jobs);

    console.log(`[Scheduler] Enqueued ${jobs.length} scrape jobs`);
  } catch (err) {
    console.error('[Scheduler] Failed to enqueue jobs:', err);
  }
}

export function startScheduler(): void {
  setInterval(() => { void enqueueAllActiveTrackers(); }, INTERVAL_MS);
  console.log(`[Scheduler] Started — running every ${INTERVAL_MS / 3600000}h via setInterval`);
}
