import { Timestamp } from 'firebase-admin/firestore';

// ─── Firestore Document Types ─────────────────────────────────────────────────

export interface UserDoc {
  uid: string;
  email: string;
  createdAt: Timestamp;
}

export interface TrackerDoc {
  id: string;
  uid: string;
  url: string;
  prompt: string;
  active: boolean;
  lastContentHash: string | null;
  lastCheckedAt: Timestamp | null;
  createdAt: Timestamp;
}

export interface NoticeDoc {
  id: string;
  trackerId: string;
  title: string;
  summary: string;
  link: string;
  noticeHash: string;
  publishedDate: string | null;
  createdAt: Timestamp;
  readAt: Timestamp | null;
}

export interface DeviceDoc {
  id: string;
  uid: string;
  fcmToken: string;
  platform: string;
  createdAt: Timestamp;
}

// ─── V2 Schema Stub (ready for source deduplication migration) ────────────────
/**
 * V2: A "Source" represents a unique URL that multiple trackers may share.
 * Instead of rendering a page once per tracker, render it once per source and
 * fan out to all trackers pointing at the same URL.
 *
 * Migration path:
 *   1. Populate sources/{sourceId} for each unique URL.
 *   2. Add sourceId field to TrackerDoc.
 *   3. Update scheduler to group trackers by sourceId.
 *   4. Update scraper worker to process per-source, not per-tracker.
 */
export interface SourceDoc {
  id: string;
  url: string;
  lastContentHash: string | null;
  lastRenderedAt: Timestamp | null;
  createdAt: Timestamp;
}

// ─── DeepSeek / AI Types ─────────────────────────────────────────────────────

export interface RawNotice {
  title: string;
  summary: string;
  date: string | null;
  link: string | null;
}

// ─── Queue Job Types ──────────────────────────────────────────────────────────

export interface ScraperJobData {
  trackerId: string;
}

// ─── API Request / Response Types ────────────────────────────────────────────

export interface AuthenticatedUser {
  uid: string;
  email: string;
}

export interface CreateTrackerBody {
  url: string;
  prompt: string;
}

export interface RegisterDeviceBody {
  fcmToken: string;
  platform?: string;
}

export interface PaginationQuery {
  limit?: number;
  startAfter?: string;
}
