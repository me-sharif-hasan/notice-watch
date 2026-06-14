import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { trackersCol } from '../../services/firestore.js';
import { validateUrl } from '../../utils/url-validator.js';
import { scraperQueue } from '../../workers/scraper.worker.js';
import type { TrackerDoc } from '../../types/index.js';

// ─── Create Tracker ───────────────────────────────────────────────────────────

/**
 * Creates a new tracker for the given user and immediately enqueues a scrape job.
 */
export async function createTracker(
  uid: string,
  url: string,
  prompt: string,
): Promise<TrackerDoc> {
  // SSRF guard — throws if URL targets private network
  validateUrl(url);

  const ref = trackersCol().doc();
  const now = Timestamp.now();

  const tracker: TrackerDoc = {
    id: ref.id,
    uid,
    url,
    prompt,
    active: true,
    lastContentHash: null,
    lastCheckedAt: null,
    createdAt: now,
  };

  await ref.set(tracker);

  // Enqueue an immediate scrape job so the user gets notices without waiting for cron
  await scraperQueue.add(
    'scrape' as Parameters<typeof scraperQueue.add>[0],
    { trackerId: ref.id },
    {
      jobId: `immediate-${ref.id}-${Date.now()}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    },
  );

  console.log(`[TrackerService] Created tracker ${ref.id} for uid=${uid}`);
  return tracker;
}

// ─── List Trackers ────────────────────────────────────────────────────────────

/**
 * Returns all active trackers owned by the given user, ordered by creation date.
 */
export async function listTrackers(uid: string): Promise<TrackerDoc[]> {
  const snap = await trackersCol()
    .where('uid', '==', uid)
    .where('active', '==', true)
    .orderBy('createdAt', 'desc')
    .get();

  return snap.docs.map((doc) => doc.data());
}

// ─── Get Tracker ──────────────────────────────────────────────────────────────

/**
 * Returns a single tracker by ID, verifying it belongs to the requesting user.
 */
export async function getTracker(uid: string, trackerId: string): Promise<TrackerDoc | null> {
  const doc = await trackersCol().doc(trackerId).get();

  if (!doc.exists) return null;

  const data = doc.data()!;
  if (data.uid !== uid) return null; // Ownership check

  return data;
}

// ─── Delete Tracker ───────────────────────────────────────────────────────────

/**
 * Soft-deletes a tracker by setting active = false.
 * Returns false if the tracker does not exist or does not belong to the user.
 */
export async function deleteTracker(uid: string, trackerId: string): Promise<boolean> {
  const ref = trackersCol().doc(trackerId);
  const doc = await ref.get();

  if (!doc.exists) return false;
  if (doc.data()!.uid !== uid) return false;

  await ref.update({ active: false, updatedAt: FieldValue.serverTimestamp() });

  console.log(`[TrackerService] Soft-deleted tracker ${trackerId} for uid=${uid}`);
  return true;
}

// ─── Toggle Active ────────────────────────────────────────────────────────────

/**
 * Toggles the active state of a tracker.
 * Returns the new active state, or null if not found / not owned.
 */
export async function toggleTracker(uid: string, trackerId: string): Promise<boolean | null> {
  const ref = trackersCol().doc(trackerId);
  const doc = await ref.get();

  if (!doc.exists) return null;

  const data = doc.data()!;
  if (data.uid !== uid) return null;

  const newActive = !data.active;
  await ref.update({ active: newActive });

  return newActive;
}
