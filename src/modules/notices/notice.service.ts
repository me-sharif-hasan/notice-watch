import { noticesCol, trackersCol } from '../../services/firestore.js';
import type { NoticeDoc } from '../../types/index.js';

// ─── Get Notices ──────────────────────────────────────────────────────────────

interface GetNoticesOptions {
  limit?: number;
  startAfter?: string;
}

/**
 * Returns paginated notices for a tracker, after verifying tracker ownership.
 * Notices are sorted newest first.
 */
export async function getNotices(
  uid: string,
  trackerId: string,
  options: GetNoticesOptions = {},
): Promise<{ notices: NoticeDoc[]; hasMore: boolean }> {
  // Ownership check — ensure the tracker belongs to this user
  const trackerDoc = await trackersCol().doc(trackerId).get();

  if (!trackerDoc.exists || trackerDoc.data()!.uid !== uid) {
    return { notices: [], hasMore: false };
  }

  const pageSize = Math.min(options.limit ?? 20, 100); // Hard cap at 100

  let query = noticesCol()
    .where('trackerId', '==', trackerId)
    .orderBy('createdAt', 'desc')
    .limit(pageSize + 1); // Fetch one extra to determine if there are more pages

  // Cursor-based pagination
  if (options.startAfter) {
    const cursorDoc = await noticesCol().doc(options.startAfter).get();
    if (cursorDoc.exists) {
      query = query.startAfter(cursorDoc);
    }
  }

  const snap = await query.get();
  const docs = snap.docs.map((doc) => doc.data());
  const hasMore = docs.length > pageSize;

  return {
    notices: docs.slice(0, pageSize),
    hasMore,
  };
}
