import { Timestamp } from 'firebase-admin/firestore';
import { devicesCol } from '../../services/firestore.js';
import type { DeviceDoc } from '../../types/index.js';

// ─── Register Device ──────────────────────────────────────────────────────────

/**
 * Registers an FCM token for a user's device.
 * If the token already exists, updates the record (upsert by fcmToken).
 */
export async function registerDevice(
  uid: string,
  fcmToken: string,
  platform: string = 'unknown',
): Promise<DeviceDoc> {
  // Upsert: check if this token is already registered
  const existing = await devicesCol().where('fcmToken', '==', fcmToken).limit(1).get();

  if (!existing.empty) {
    const ref = existing.docs[0].ref;
    const existingData = existing.docs[0].data();

    // Update uid in case token moved to a different account
    await ref.update({ uid, platform });

    return { ...existingData, uid, platform };
  }

  const ref = devicesCol().doc();
  const now = Timestamp.now();

  const device: DeviceDoc = {
    id: ref.id,
    uid,
    fcmToken,
    platform,
    createdAt: now,
  };

  await ref.set(device);

  console.log(`[DeviceService] Registered device ${ref.id} for uid=${uid}`);
  return device;
}

// ─── List Devices ─────────────────────────────────────────────────────────────

export async function listDevices(uid: string): Promise<DeviceDoc[]> {
  const snap = await devicesCol().where('uid', '==', uid).get();
  return snap.docs.map((doc) => doc.data());
}

// ─── Unregister Device ────────────────────────────────────────────────────────

/**
 * Removes a device registration by ID.
 * Returns false if device not found or not owned by the requesting user.
 */
export async function unregisterDevice(uid: string, deviceId: string): Promise<boolean> {
  const ref = devicesCol().doc(deviceId);
  const doc = await ref.get();

  if (!doc.exists) return false;
  if (doc.data()!.uid !== uid) return false;

  await ref.delete();

  console.log(`[DeviceService] Unregistered device ${deviceId} for uid=${uid}`);
  return true;
}
