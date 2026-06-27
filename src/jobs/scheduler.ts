import { Timestamp, FieldValue } from 'firebase-admin/firestore';
import { trackersCol, usersCol, getDb } from '../services/firestore.js';
import { urlHash } from '../utils/hash.js';
import { scraperQueue } from '../workers/scraper.worker.js';
import { sendToUser } from '../services/fcm.js';

const SCRAPER_INTERVAL_MS = 6 * 60 * 60 * 1000;   // 6 hours
const COIN_INTERVAL_MS    = 24 * 60 * 60 * 1000;   // 24 hours
const FREE_LIMIT          = 5;

// ─── Scraper Scheduler ────────────────────────────────────────────────────────

async function enqueueAllActiveTrackers(): Promise<void> {
  console.log('[Scheduler] Starting scheduled scrape cycle...');

  try {
    const snap = await trackersCol().where('active', '==', true).get();
    const trackers = snap.docs.map((doc) => doc.data());

    console.log(`[Scheduler] Found ${trackers.length} active trackers`);
    if (trackers.length === 0) return;

    const sourceIds = new Set<string>();
    for (const tracker of trackers) {
      sourceIds.add(tracker.sourceId ?? urlHash(tracker.url));
    }

    const cycleBucket = Math.floor(Date.now() / SCRAPER_INTERVAL_MS);

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

    console.log(`[Scheduler] Enqueued ${jobs.length} source jobs for ${trackers.length} trackers`);
  } catch (err) {
    console.error('[Scheduler] Failed to enqueue jobs:', err);
  }
}

// ─── Coin Deduction Sweep ─────────────────────────────────────────────────────

async function disableExtraTrackers(uid: string, countToDisable: number): Promise<number> {
  if (countToDisable <= 0) return 0;

  const snap = await trackersCol()
    .where('uid', '==', uid)
    .where('active', '==', true)
    .orderBy('createdAt', 'desc')
    .limit(countToDisable)
    .get();

  if (snap.empty) return 0;

  const batch = getDb().batch();
  for (const doc of snap.docs) {
    batch.update(doc.ref, { active: false });
  }
  await batch.commit();
  return snap.docs.length;
}

async function runCoinDeductionSweep(): Promise<void> {
  console.log('[CoinSweep] Starting daily coin deduction sweep...');

  try {
    const snap = await usersCol()
      .where('subscribed', '==', false)
      .where('trackerCount', '>', FREE_LIMIT)
      .get();

    console.log(`[CoinSweep] Processing ${snap.docs.length} users with extra trackers`);

    for (const doc of snap.docs) {
      const user = doc.data();
      const now = Date.now();
      const lastDeducted = user.lastCoinDeductedAt?.toMillis() ?? user.createdAt.toMillis();
      const daysSince = Math.floor((now - lastDeducted) / 86400000);

      if (daysSince < 1) continue;

      const extraTrackers = user.trackerCount - FREE_LIMIT;
      const coinsToDeduct = extraTrackers * daysSince;
      const newCoins = user.coins - coinsToDeduct;

      if (newCoins <= 0) {
        const countToDisable = user.trackerCount - FREE_LIMIT;
        const actualDisabled = await disableExtraTrackers(user.uid, countToDisable);

        await usersCol().doc(user.uid).update({
          coins: 0,
          trackerCount: FieldValue.increment(-actualDisabled),
          lastCoinDeductedAt: Timestamp.now(),
        });

        console.log(`[CoinSweep] Disabled ${actualDisabled} trackers for uid=${user.uid} (coins exhausted)`);

        try {
          await sendToUser(
            user.uid,
            'Trackers Disabled',
            'Your tracking coins ran out. Watch an ad to earn coins and re-enable your trackers.',
            { type: 'tracker_disabled' },
          );
        } catch (err) {
          console.error(`[CoinSweep] FCM failed for uid=${user.uid}:`, err);
        }
      } else {
        await usersCol().doc(user.uid).update({
          coins: newCoins,
          lastCoinDeductedAt: Timestamp.now(),
        });

        console.log(`[CoinSweep] Deducted ${coinsToDeduct} coins from uid=${user.uid} (remaining=${newCoins})`);

        if (newCoins <= 3) {
          try {
            await sendToUser(
              user.uid,
              'Low on Coins',
              `Only ${newCoins} tracking coin${newCoins === 1 ? '' : 's'} left. Watch an ad to top up.`,
              { type: 'coins_low', coins: String(newCoins) },
            );
          } catch (err) {
            console.error(`[CoinSweep] FCM warning failed for uid=${user.uid}:`, err);
          }
        }
      }
    }

    console.log('[CoinSweep] Done');
  } catch (err) {
    console.error('[CoinSweep] Failed:', err);
  }
}

// ─── Start Scheduler ──────────────────────────────────────────────────────────

export function startScheduler(): void {
  setInterval(() => { void enqueueAllActiveTrackers(); }, SCRAPER_INTERVAL_MS);
  console.log(`[Scheduler] Scraper started — every ${SCRAPER_INTERVAL_MS / 3600000}h`);

  setInterval(() => { void runCoinDeductionSweep(); }, COIN_INTERVAL_MS);
  console.log('[Scheduler] Coin deduction sweep started — every 24h');
}
