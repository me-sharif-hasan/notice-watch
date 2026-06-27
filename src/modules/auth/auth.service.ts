import { Timestamp, FieldValue } from 'firebase-admin/firestore';
import { usersCol, trackersCol, getDb } from '../../services/firestore.js';
import type { UserDoc } from '../../types/index.js';

const FREE_TRACKER_LIMIT = 5;
const SUBSCRIBED_TRACKER_LIMIT = 100;

// ─── Create or Get User ───────────────────────────────────────────────────────

export async function createOrGetUser(
  uid: string,
  email: string | null,
  anonymous: boolean,
): Promise<UserDoc> {
  const now = Timestamp.now();
  const userRef = usersCol().doc(uid);

  const newUser: UserDoc = {
    uid,
    email,
    anonymous,
    subscribed: false,
    subscribedUntil: null,
    coins: 0,
    trackerCount: 0,
    lastCoinDeductedAt: now,
    createdAt: now,
  };

  try {
    await userRef.create(newUser);
    return newUser;
  } catch (err: unknown) {
    if ((err as { code?: number })?.code === 6) {
      const snap = await userRef.get();
      return snap.data() as UserDoc;
    }
    throw err;
  }
}

// ─── Get Me ───────────────────────────────────────────────────────────────────

export async function getMe(uid: string): Promise<{ user: UserDoc; trackerLimit: number }> {
  const userRef = usersCol().doc(uid);
  const snap = await userRef.get();

  if (!snap.exists) {
    throw new Error('User not found');
  }

  let user = snap.data() as UserDoc;
  const trackerLimit = user.subscribed ? SUBSCRIBED_TRACKER_LIMIT : FREE_TRACKER_LIMIT;

  // Lazy coin deduction
  const now = Date.now();
  const lastDeducted = user.lastCoinDeductedAt?.toMillis() ?? user.createdAt.toMillis();
  const daysSince = Math.floor((now - lastDeducted) / 86400000);

  if (daysSince >= 1 && !user.subscribed && user.trackerCount > FREE_TRACKER_LIMIT) {
    const extraTrackers = user.trackerCount - FREE_TRACKER_LIMIT;
    const coinsToDeduct = extraTrackers * daysSince;
    const newCoins = user.coins - coinsToDeduct;

    if (newCoins <= 0) {
      const countToDisable = user.trackerCount - FREE_TRACKER_LIMIT;
      await disableExtraTrackers(uid, countToDisable);
      await userRef.update({
        coins: 0,
        trackerCount: FREE_TRACKER_LIMIT,
        lastCoinDeductedAt: Timestamp.now(),
      });
      user = { ...user, coins: 0, trackerCount: FREE_TRACKER_LIMIT, lastCoinDeductedAt: Timestamp.now() };
    } else {
      await userRef.update({ coins: newCoins, lastCoinDeductedAt: Timestamp.now() });
      user = { ...user, coins: newCoins, lastCoinDeductedAt: Timestamp.now() };
    }
  } else if (daysSince >= 1) {
    await userRef.update({ lastCoinDeductedAt: Timestamp.now() });
    user = { ...user, lastCoinDeductedAt: Timestamp.now() };
  }

  return { user, trackerLimit };
}

// ─── Disable Extra Trackers (newest first) ────────────────────────────────────

export async function disableExtraTrackers(uid: string, countToDisable: number): Promise<void> {
  if (countToDisable <= 0) return;

  const snap = await trackersCol()
    .where('uid', '==', uid)
    .where('active', '==', true)
    .orderBy('createdAt', 'desc')
    .limit(countToDisable)
    .get();

  if (snap.empty) return;

  const batch = getDb().batch();
  for (const doc of snap.docs) {
    batch.update(doc.ref, { active: false });
  }
  // Adjust trackerCount by how many we actually disabled
  const disabledCount = snap.docs.length;
  batch.update(usersCol().doc(uid), {
    trackerCount: FieldValue.increment(-disabledCount),
  });
  await batch.commit();
}
