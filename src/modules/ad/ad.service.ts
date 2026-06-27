import { createVerify } from 'crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { usersCol, adSsvEventsCol } from '../../services/firestore.js';
import { sendToUser } from '../../services/fcm.js';

const COIN_CAP = 50;

// Cache AdMob verifier keys (refreshed hourly)
let cachedKeys: Record<string, string> = {};
let keysCachedAt = 0;
const KEYS_TTL_MS = 60 * 60 * 1000;

async function getAdMobVerifierKeys(): Promise<Record<string, string>> {
  if (Date.now() - keysCachedAt < KEYS_TTL_MS && Object.keys(cachedKeys).length > 0) {
    return cachedKeys;
  }

  const res = await fetch('https://gstatic.com/admob/reward/verifier-keys.json');
  if (!res.ok) throw new Error(`Failed to fetch AdMob verifier keys: ${res.status}`);

  const json = await res.json() as { keys: Array<{ keyId: number; pem: string; base64: string }> };
  const keys: Record<string, string> = {};
  for (const key of json.keys) {
    keys[String(key.keyId)] = key.pem;
  }

  cachedKeys = keys;
  keysCachedAt = Date.now();
  return keys;
}

function verifyAdMobSignature(
  queryString: string,
  signature: string,
  publicKeyPem: string,
): boolean {
  try {
    // AdMob SSV: signature covers the full query string minus the `signature` param
    // The query string arrives pre-stripped by the caller
    const verifier = createVerify('SHA256');
    verifier.update(queryString, 'utf8');
    // AdMob signature is URL-safe base64 — convert to standard base64
    const sigBase64 = signature.replace(/-/g, '+').replace(/_/g, '/');
    return verifier.verify(publicKeyPem, sigBase64, 'base64');
  } catch {
    return false;
  }
}

// ─── Process AdMob SSV Callback ───────────────────────────────────────────────

export async function processAdSsvCallback(params: {
  transaction_id: string;
  custom_data: string;   // = firebase uid
  reward_amount: string;
  reward_item: string;
  signature: string;
  key_id: string;
  rawQueryStringWithoutSignature: string;
}): Promise<void> {
  const { transaction_id, custom_data: uid, reward_amount, signature, key_id, rawQueryStringWithoutSignature } = params;

  // 1. Verify signature
  const keys = await getAdMobVerifierKeys();
  const publicKey = keys[key_id];

  if (!publicKey) {
    throw new Error(`Unknown AdMob key_id: ${key_id}`);
  }

  const isValid = verifyAdMobSignature(rawQueryStringWithoutSignature, signature, publicKey);
  if (!isValid) {
    throw new Error('Invalid AdMob SSV signature');
  }

  // 2. Idempotency check
  const eventRef = adSsvEventsCol().doc(transaction_id);
  const existing = await eventRef.get();
  if (existing.exists) {
    console.log(`[AdSSV] Already processed transaction ${transaction_id}, skipping`);
    return;
  }

  // 3. Get user and compute new coins
  const userRef = usersCol().doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    throw new Error(`User ${uid} not found for AdMob SSV`);
  }

  const user = userSnap.data()!;
  const rewardCoins = parseInt(reward_amount, 10) || 0;
  const newCoins = Math.min(user.coins + rewardCoins, COIN_CAP);
  const actualGranted = newCoins - user.coins;

  // 4. Store event first (idempotency guard) then update coins
  await eventRef.set({
    id: transaction_id,
    uid,
    grantedCoins: actualGranted,
    processedAt: Timestamp.now(),
  });

  await userRef.update({ coins: newCoins });

  // 5. Notify user
  if (actualGranted > 0) {
    try {
      await sendToUser(uid, 'Coins Earned!', `You earned ${actualGranted} tracking coin${actualGranted === 1 ? '' : 's'}.`, {
        type: 'coins_earned',
        coins: String(actualGranted),
        totalCoins: String(newCoins),
      });
    } catch (err) {
      console.error('[AdSSV] FCM notification failed:', err);
    }
  }

  console.log(`[AdSSV] Granted ${actualGranted} coins to uid=${uid} (total=${newCoins})`);
}
