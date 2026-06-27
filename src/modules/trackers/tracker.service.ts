import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { trackersCol, sourcesCol, usersCol, settingsDoc } from '../../services/firestore.js';
import { validateUrl } from '../../utils/url-validator.js';
import { urlHash } from '../../utils/hash.js';
import { scraperQueue } from '../../workers/scraper.worker.js';
import type { TrackerDoc, SourceDoc } from '../../types/index.js';

const FREE_LIMIT = 5;
const SUBSCRIBED_LIMIT = 100;
const SCRAPE_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getTrackerLimit(uid: string): Promise<number> {
  const userSnap = await usersCol().doc(uid).get();
  if (!userSnap.exists) return FREE_LIMIT;
  const user = userSnap.data()!;
  return user.subscribed ? SUBSCRIBED_LIMIT : FREE_LIMIT;
}

async function requireIntegrationToken(): Promise<boolean> {
  try {
    const snap = await settingsDoc().get();
    if (!snap.exists) return false;
    return snap.data()!.requireIntegrationToken ?? false;
  } catch {
    return false;
  }
}

// ─── Create Tracker ───────────────────────────────────────────────────────────

export async function createTracker(
  uid: string,
  url: string,
  prompt: string,
  globalFlag: boolean,
  anonymous: boolean,
  integrityToken?: string,
): Promise<TrackerDoc> {
  validateUrl(url);

  // Integration token check
  const tokenRequired = await requireIntegrationToken();
  if (tokenRequired) {
    if (!integrityToken || integrityToken.trim() === '') {
      throw new Error('INTEGRITY_TOKEN_REQUIRED');
    }
    // Real Play Integrity verification goes here — stub for now
    console.log(`[TrackerService] Integrity token present (verification stubbed)`);
  }

  // Tracker limit check
  const userSnap = await usersCol().doc(uid).get();
  if (!userSnap.exists) throw new Error('User not found');
  const user = userSnap.data()!;
  const limit = user.subscribed ? SUBSCRIBED_LIMIT : FREE_LIMIT;
  if (user.trackerCount >= limit) throw new Error('TRACKER_LIMIT_REACHED');

  // Anonymous users always get global=true
  const isGlobal = anonymous ? true : globalFlag;

  const now = Timestamp.now();
  const sourceId = urlHash(url);

  const sourceRef = sourcesCol().doc(sourceId);
  const source: SourceDoc = {
    id: sourceId,
    url,
    lastContentHash: null,
    lastRenderedAt: null,
    createdAt: now,
  };
  await sourceRef.set(source, { merge: true });

  const ref = trackersCol().doc();
  const tracker: TrackerDoc = {
    id: ref.id,
    uid,
    url,
    prompt,
    active: true,
    sourceId,
    global: isGlobal,
    lastManualScrapeAt: null,
    lastCheckedAt: null,
    createdAt: now,
  };

  await ref.set(tracker);

  // Increment trackerCount atomically
  await usersCol().doc(uid).update({ trackerCount: FieldValue.increment(1) });

  await scraperQueue.add(
    'scrape' as Parameters<typeof scraperQueue.add>[0],
    { sourceId },
    {
      jobId: `immediate-${sourceId}-${Date.now()}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    },
  );

  console.log(`[TrackerService] Created tracker ${ref.id} for uid=${uid}`);
  return tracker;
}

// ─── List Trackers ────────────────────────────────────────────────────────────

export async function listTrackers(uid: string): Promise<TrackerDoc[]> {
  const snap = await trackersCol()
    .where('uid', '==', uid)
    .where('active', '==', true)
    .orderBy('createdAt', 'desc')
    .get();

  return snap.docs.map((doc) => doc.data());
}

// ─── Get Tracker ──────────────────────────────────────────────────────────────

export async function getTracker(uid: string, trackerId: string): Promise<TrackerDoc | null> {
  const doc = await trackersCol().doc(trackerId).get();
  if (!doc.exists) return null;
  const data = doc.data()!;
  if (data.uid !== uid) return null;
  return data;
}

// ─── Delete Tracker ───────────────────────────────────────────────────────────

export async function deleteTracker(uid: string, trackerId: string): Promise<boolean> {
  const ref = trackersCol().doc(trackerId);
  const doc = await ref.get();

  if (!doc.exists) return false;
  if (doc.data()!.uid !== uid) return false;

  const wasActive = doc.data()!.active;

  await ref.update({ active: false });

  // Only decrement if it was active
  if (wasActive) {
    await usersCol().doc(uid).update({ trackerCount: FieldValue.increment(-1) });
  }

  console.log(`[TrackerService] Deleted tracker ${trackerId} for uid=${uid}`);
  return true;
}

// ─── Toggle Active ────────────────────────────────────────────────────────────

export async function toggleTracker(uid: string, trackerId: string): Promise<boolean | null> {
  const ref = trackersCol().doc(trackerId);
  const doc = await ref.get();

  if (!doc.exists) return null;
  const data = doc.data()!;
  if (data.uid !== uid) return null;

  const newActive = !data.active;

  if (newActive) {
    // Turning ON — check limit first
    const userSnap = await usersCol().doc(uid).get();
    const user = userSnap.data()!;
    const limit = user.subscribed ? SUBSCRIBED_LIMIT : FREE_LIMIT;
    if (user.trackerCount >= limit) throw new Error('TRACKER_LIMIT_REACHED');
    await usersCol().doc(uid).update({ trackerCount: FieldValue.increment(1) });
  } else {
    // Turning OFF — decrement
    await usersCol().doc(uid).update({ trackerCount: FieldValue.increment(-1) });
  }

  await ref.update({ active: newActive });
  return newActive;
}

// ─── Update Tracker ───────────────────────────────────────────────────────────

export async function updateTracker(
  uid: string,
  trackerId: string,
  updates: { prompt?: string; global?: boolean },
): Promise<TrackerDoc | null> {
  const ref = trackersCol().doc(trackerId);
  const doc = await ref.get();

  if (!doc.exists) return null;
  const data = doc.data()!;
  if (data.uid !== uid) return null;

  const patch: Partial<TrackerDoc> = {};
  if (updates.prompt !== undefined) patch.prompt = updates.prompt;
  if (updates.global !== undefined) patch.global = updates.global;

  if (Object.keys(patch).length === 0) return data;

  await ref.update(patch);
  return { ...data, ...patch };
}

// ─── Manual Scrape ────────────────────────────────────────────────────────────

export async function manualScrape(uid: string, trackerId: string): Promise<void> {
  const ref = trackersCol().doc(trackerId);
  const doc = await ref.get();

  if (!doc.exists) throw new Error('Tracker not found');
  const data = doc.data()!;
  if (data.uid !== uid) throw new Error('Not authorized');

  if (data.lastManualScrapeAt) {
    const elapsed = Date.now() - data.lastManualScrapeAt.toMillis();
    if (elapsed < SCRAPE_COOLDOWN_MS) throw new Error('SCRAPE_COOLDOWN');
  }

  await ref.update({ lastManualScrapeAt: Timestamp.now() });

  await scraperQueue.add(
    'scrape' as Parameters<typeof scraperQueue.add>[0],
    { sourceId: data.sourceId },
    {
      jobId: `manual-${data.sourceId}-${Date.now()}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    },
  );

  console.log(`[TrackerService] Manual scrape triggered for tracker ${trackerId}`);
}
