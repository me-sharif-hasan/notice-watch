import { admin } from './firestore.js';
import { getDb } from './firestore.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface MulticastResult {
  successCount: number;
  failureCount: number;
}

// ─── Token Lookup ─────────────────────────────────────────────────────────────

/**
 * Retrieves all active FCM tokens for a given user from the devices collection.
 */
async function getFcmTokensForUser(uid: string): Promise<string[]> {
  const snap = await getDb().collection('devices').where('uid', '==', uid).get();

  return snap.docs.map((doc) => doc.data()['fcmToken'] as string).filter(Boolean);
}

// ─── Send Notification ────────────────────────────────────────────────────────

/**
 * Sends a push notification to all devices registered for a user.
 *
 * @param uid       Firebase Auth UID of the target user
 * @param title     Notification title (shown in status bar)
 * @param body      Notification body text
 * @param data      Key-value payload delivered to the app (trackerId, noticeId, etc.)
 */
export async function sendToUser(
  uid: string,
  title: string,
  body: string,
  data: Record<string, string>,
): Promise<MulticastResult> {
  const tokens = await getFcmTokensForUser(uid);

  if (tokens.length === 0) {
    console.warn(`[FCM] No devices registered for uid=${uid}, skipping notification`);
    return { successCount: 0, failureCount: 0 };
  }

  const message: admin.messaging.MulticastMessage = {
    tokens,
    notification: { title, body },
    data,
    android: {
      priority: 'high',
      notification: {
        sound: 'default',
        channelId: 'notice_alerts',
      },
    },
    apns: {
      payload: {
        aps: {
          sound: 'default',
          badge: 1,
        },
      },
    },
  };

  try {
    const response = await admin.messaging().sendEachForMulticast(message);

    if (response.failureCount > 0) {
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          console.error(
            `[FCM] Failed to send to token[${idx}] (${tokens[idx]}):`,
            resp.error?.message,
          );
          // TODO: Remove stale tokens (e.g. messaging/registration-token-not-registered)
        }
      });
    }

    console.log(
      `[FCM] Sent to ${response.successCount}/${tokens.length} devices for uid=${uid}`,
    );

    return {
      successCount: response.successCount,
      failureCount: response.failureCount,
    };
  } catch (err) {
    console.error(`[FCM] Multicast failed for uid=${uid}:`, err);
    throw err;
  }
}
