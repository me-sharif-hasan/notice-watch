import admin from 'firebase-admin';
import { getFirestore, Firestore, CollectionReference, DocumentReference } from 'firebase-admin/firestore';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { UserDoc, TrackerDoc, NoticeDoc, DeviceDoc, SourceDoc, AdSsvEventDoc, GlobalSettingsDoc, IntegrationTokenDoc } from '../types/index.js';

// ─── Initialize Firebase Admin ────────────────────────────────────────────────

const serviceAccountPath = resolve(
  process.env.FIREBASE_SERVICE_ACCOUNT_PATH ?? './service-account.json',
);

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8')) as admin.ServiceAccount;

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

export { admin };

// ─── Firestore Singleton ──────────────────────────────────────────────────────

let _db: Firestore | null = null;

export function getDb(): Firestore {
  if (!_db) {
    _db = getFirestore();
  }
  return _db;
}

// ─── Typed Collection References ─────────────────────────────────────────────

export function usersCol(): CollectionReference<UserDoc> {
  return getDb().collection('users') as CollectionReference<UserDoc>;
}

export function trackersCol(): CollectionReference<TrackerDoc> {
  return getDb().collection('trackers') as CollectionReference<TrackerDoc>;
}

export function noticesCol(): CollectionReference<NoticeDoc> {
  return getDb().collection('notices') as CollectionReference<NoticeDoc>;
}

export function devicesCol(): CollectionReference<DeviceDoc> {
  return getDb().collection('devices') as CollectionReference<DeviceDoc>;
}

export function sourcesCol(): CollectionReference<SourceDoc> {
  return getDb().collection('sources') as CollectionReference<SourceDoc>;
}

export function adSsvEventsCol(): CollectionReference<AdSsvEventDoc> {
  return getDb().collection('adSsvEvents') as CollectionReference<AdSsvEventDoc>;
}

export function settingsDoc(): DocumentReference<GlobalSettingsDoc> {
  return getDb().collection('settings').doc('global') as DocumentReference<GlobalSettingsDoc>;
}

export function integrationTokensCol(): CollectionReference<IntegrationTokenDoc> {
  return getDb().collection('integrationTokens') as CollectionReference<IntegrationTokenDoc>;
}
