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
  sourceId: string;
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
  sourceId: string;
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
