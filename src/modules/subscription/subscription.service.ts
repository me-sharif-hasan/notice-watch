import { Timestamp } from 'firebase-admin/firestore';
import { usersCol } from '../../services/firestore.js';
import { cacheDel, CacheKey } from '../../services/cache.js';

const PACKAGE_NAME = process.env.GOOGLE_PLAY_PACKAGE_NAME ?? '';

// ─── Google Play Auth ─────────────────────────────────────────────────────────

async function getGooglePlayAccessToken(): Promise<string> {
  const keyJson = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error('GOOGLE_PLAY_SERVICE_ACCOUNT_KEY not configured');

  const key = JSON.parse(keyJson) as {
    client_email: string;
    private_key: string;
  };

  // Build JWT for Google OAuth2
  const { SignJWT, importPKCS8 } = await import('jose');
  const now = Math.floor(Date.now() / 1000);
  const privateKey = await importPKCS8(key.private_key, 'RS256');

  const jwt = await new SignJWT({
    scope: 'https://www.googleapis.com/auth/androidpublisher',
  })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .setIssuer(key.client_email)
    .setAudience('https://oauth2.googleapis.com/token')
    .sign(privateKey);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!res.ok) throw new Error(`Google OAuth failed: ${res.status}`);
  const data = await res.json() as { access_token: string };
  return data.access_token;
}

// ─── Verify Google Play Purchase ──────────────────────────────────────────────

export async function verifyGooglePlayPurchase(
  uid: string,
  purchaseToken: string,
  productId: string,
): Promise<void> {
  const accessToken = await getGooglePlayAccessToken();

  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE_NAME}/purchases/subscriptions/${productId}/tokens/${purchaseToken}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google Play verification failed: ${res.status} — ${body}`);
  }

  const data = await res.json() as {
    expiryTimeMillis?: string;
    paymentState?: number;
    cancelReason?: number;
  };

  // paymentState: 0=pending, 1=received, 2=free trial, 3=deferred
  const isPaid = data.paymentState === 1 || data.paymentState === 2;
  const expiryMs = data.expiryTimeMillis ? parseInt(data.expiryTimeMillis, 10) : 0;
  const notExpired = expiryMs > Date.now();

  if (!isPaid || !notExpired) {
    throw new Error('Subscription not active');
  }

  await usersCol().doc(uid).update({
    subscribed: true,
    subscribedUntil: Timestamp.fromMillis(expiryMs),
  });
  void cacheDel(CacheKey.user(uid));

  console.log(`[Subscription] Verified for uid=${uid}, expires=${new Date(expiryMs).toISOString()}`);
}

// ─── Handle RTDN Notification ─────────────────────────────────────────────────

interface DeveloperNotification {
  packageName: string;
  eventTimeMillis: string;
  subscriptionNotification?: {
    version: string;
    notificationType: number;
    purchaseToken: string;
    subscriptionId: string;
  };
}

// notificationType codes
const RENEWED = 2;
const REVOKED = 8;
const EXPIRED = 9;

export async function handleRtdnNotification(messageData: string): Promise<void> {
  let notification: DeveloperNotification;

  try {
    const decoded = Buffer.from(messageData, 'base64').toString('utf8');
    notification = JSON.parse(decoded) as DeveloperNotification;
  } catch (err) {
    console.error('[RTDN] Failed to decode notification:', err);
    return;
  }

  const sub = notification.subscriptionNotification;
  if (!sub) {
    console.log('[RTDN] No subscriptionNotification in payload, ignoring');
    return;
  }

  const { notificationType, purchaseToken, subscriptionId } = sub;

  console.log(`[RTDN] notificationType=${notificationType} for subscription ${subscriptionId}`);

  if (notificationType === RENEWED) {
    // Re-verify to get updated expiryTimeMillis — find user by purchaseToken
    // In production, store purchaseToken on UserDoc for reverse lookup
    // For now: log and rely on app calling /verify on open
    console.log('[RTDN] Subscription renewed — app will re-verify on next open');
    return;
  }

  if (notificationType === REVOKED || notificationType === EXPIRED) {
    // Find user by purchaseToken — requires index; stub for now with a scan
    // In production: store purchaseToken on UserDoc and index it
    console.warn(`[RTDN] Subscription ${notificationType === REVOKED ? 'revoked' : 'expired'} for token ${purchaseToken.slice(0, 20)}...`);
    // TODO: store purchaseToken on UserDoc at verify time, then look up here
    return;
  }

  console.log(`[RTDN] Unhandled notificationType=${notificationType}, ignoring`);
}
