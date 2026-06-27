import { Timestamp } from 'firebase-admin/firestore';
import { noticesCol, trackersCol, getDb } from '../../services/firestore.js';
import type { NoticeDoc } from '../../types/index.js';

interface GetNoticesOptions {
  limit?: number;
  startAfter?: string;
}

// ─── Get Notices (per tracker) ────────────────────────────────────────────────

export async function getNotices(
  uid: string,
  trackerId: string,
  options: GetNoticesOptions = {},
): Promise<{ notices: NoticeDoc[]; hasMore: boolean }> {
  const trackerDoc = await trackersCol().doc(trackerId).get();

  if (!trackerDoc.exists || trackerDoc.data()!.uid !== uid) {
    return { notices: [], hasMore: false };
  }

  const pageSize = Math.min(options.limit ?? 20, 100);

  let query = noticesCol()
    .where('trackerId', '==', trackerId)
    .orderBy('createdAt', 'desc')
    .limit(pageSize + 1);

  if (options.startAfter) {
    const cursorDoc = await noticesCol().doc(options.startAfter).get();
    if (cursorDoc.exists) query = query.startAfter(cursorDoc);
  }

  const snap = await query.get();
  const docs = snap.docs.map((doc) => doc.data());
  const hasMore = docs.length > pageSize;

  return { notices: docs.slice(0, pageSize), hasMore };
}

// ─── Get My Notices (cross-tracker, mine) ─────────────────────────────────────

export async function getMyNotices(
  uid: string,
  options: GetNoticesOptions = {},
): Promise<{ notices: NoticeDoc[]; hasMore: boolean }> {
  // Get all user tracker IDs
  const trackerSnap = await trackersCol()
    .where('uid', '==', uid)
    .where('active', '==', true)
    .get();

  const trackerIds = trackerSnap.docs.map((d) => d.id);
  if (trackerIds.length === 0) return { notices: [], hasMore: false };

  const pageSize = Math.min(options.limit ?? 20, 100);

  // Firestore 'in' limit = 30 — chunk if needed
  const chunks: string[][] = [];
  for (let i = 0; i < trackerIds.length; i += 30) {
    chunks.push(trackerIds.slice(i, i + 30));
  }

  const allNotices: NoticeDoc[] = [];

  for (const chunk of chunks) {
    let q = noticesCol()
      .where('trackerId', 'in', chunk)
      .orderBy('createdAt', 'desc')
      .limit(pageSize + 1);

    if (options.startAfter) {
      const cursorDoc = await noticesCol().doc(options.startAfter).get();
      if (cursorDoc.exists) q = q.startAfter(cursorDoc);
    }

    const snap = await q.get();
    allNotices.push(...snap.docs.map((d) => d.data()));
  }

  // Sort merged results by createdAt desc, then paginate
  allNotices.sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis());
  const hasMore = allNotices.length > pageSize;

  return { notices: allNotices.slice(0, pageSize), hasMore };
}

// ─── Get Global Notices ───────────────────────────────────────────────────────

export async function getGlobalNotices(
  options: GetNoticesOptions = {},
): Promise<{ notices: NoticeDoc[]; hasMore: boolean }> {
  const pageSize = Math.min(options.limit ?? 20, 100);

  let query = noticesCol()
    .where('global', '==', true)
    .orderBy('createdAt', 'desc')
    .limit(pageSize + 1);

  if (options.startAfter) {
    const cursorDoc = await noticesCol().doc(options.startAfter).get();
    if (cursorDoc.exists) query = query.startAfter(cursorDoc);
  }

  const snap = await query.get();
  const docs = snap.docs.map((d) => d.data());
  const hasMore = docs.length > pageSize;

  return { notices: docs.slice(0, pageSize), hasMore };
}

// ─── Get Notice By ID ─────────────────────────────────────────────────────────

export async function getNoticeById(uid: string, noticeId: string): Promise<NoticeDoc | null> {
  const noticeSnap = await noticesCol().doc(noticeId).get();
  if (!noticeSnap.exists) return null;

  const notice = noticeSnap.data() as NoticeDoc;

  // Allow access if: user owns the tracker OR notice is global
  if (notice.global) return notice;

  const trackerSnap = await trackersCol().doc(notice.trackerId).get();
  if (!trackerSnap.exists) return null;
  if (trackerSnap.data()!.uid !== uid) return null;

  return notice;
}

// ─── Mark Notice as Read ──────────────────────────────────────────────────────

export async function markNoticeAsRead(uid: string, noticeId: string): Promise<void> {
  const noticeRef = noticesCol().doc(noticeId);
  const noticeSnap = await noticeRef.get();

  if (!noticeSnap.exists) throw new Error('Notice not found');

  const notice = noticeSnap.data() as NoticeDoc;

  const trackerSnap = await trackersCol().doc(notice.trackerId).get();
  if (!trackerSnap.exists || trackerSnap.data()!.uid !== uid) {
    throw new Error('Not authorized');
  }

  await noticeRef.update({ readAt: Timestamp.now() });
}

// ─── Mark All Read ────────────────────────────────────────────────────────────

export async function markAllRead(uid: string, trackerId: string): Promise<void> {
  const trackerSnap = await trackersCol().doc(trackerId).get();
  if (!trackerSnap.exists || trackerSnap.data()!.uid !== uid) {
    throw new Error('Not authorized');
  }

  const unreadSnap = await noticesCol()
    .where('trackerId', '==', trackerId)
    .where('readAt', '==', null)
    .get();

  if (unreadSnap.empty) return;

  const now = Timestamp.now();
  const batch = getDb().batch();
  for (const doc of unreadSnap.docs) {
    batch.update(doc.ref, { readAt: now });
  }
  await batch.commit();
}
