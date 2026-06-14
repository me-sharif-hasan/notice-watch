import cron from 'node-cron';
import { trackersCol } from '../services/firestore.js';
import { scraperQueue } from '../workers/scraper.worker.js';

/**
 * Loads all active trackers from Firestore and enqueues a scrape job for each.
 *
 * Uses the trackerId as the BullMQ jobId (with a 'cron-' prefix) so that if a
 * tracker is already queued from a previous cron cycle that hasn't completed,
 * BullMQ will deduplicate it and not add a duplicate job.
 */
async function enqueueAllActiveTrackers(): Promise<void> {
  console.log('[Scheduler] Starting scheduled scrape cycle...');

  try {
    const snap = await trackersCol().where('active', '==', true).get();
    const trackers = snap.docs.map((doc) => doc.data());

    console.log(`[Scheduler] Found ${trackers.length} active trackers`);

    if (trackers.length === 0) return;

    // Bulk-add jobs with deduplication by jobId
    const jobs = trackers.map((tracker) => ({
      name: 'scrape' as Parameters<typeof scraperQueue.add>[0],
      data: { trackerId: tracker.id },
      opts: {
        jobId: `cron-${tracker.id}`, // Deduplicates: same tracker won't queue twice
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

/**
 * Starts the cron scheduler.
 * Runs every 6 hours: at minute 0 of hours 0, 6, 12, 18.
 */
export function startScheduler(): void {
  cron.schedule('0 */6 * * *', () => {
    void enqueueAllActiveTrackers();
  });

  console.log('[Scheduler] Started — running every 6 hours (0 */6 * * *)');
}
