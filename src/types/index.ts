import { Timestamp } from 'firebase-admin/firestore';

// ─── Firestore Document Types ─────────────────────────────────────────────────

export interface UserDoc {
  uid: string;
  email: string | null;
  anonymous: boolean;
  subscribed: boolean;
  subscribedUntil: Timestamp | null;
  coins: number;
  trackerCount: number;
  lastCoinDeductedAt: Timestamp | null;
  createdAt: Timestamp;
}

export interface TrackerDoc {
  id: string;
  uid: string;
  url: string;
  prompt: string;
  active: boolean;
  sourceId: string;
  global: boolean;
  lastManualScrapeAt: Timestamp | null;
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
  global: boolean;
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

export interface AdSsvEventDoc {
  id: string;
  uid: string;
  grantedCoins: number;
  processedAt: Timestamp;
}

export interface GlobalSettingsDoc {
  requireIntegrationToken: boolean;
}

export interface IntegrationTokenDoc {
  token: string;
  label: string;
  active: boolean;
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
  email: string | null;
  anonymous: boolean;
}

export interface CreateTrackerBody {
  url: string;
  prompt: string;
  global?: boolean;
  integrityToken?: string;
}

export interface UpdateTrackerBody {
  prompt?: string;
  global?: boolean;
}

export interface RegisterDeviceBody {
  fcmToken: string;
  platform?: string;
}

export interface PaginationQuery {
  limit?: number;
  startAfter?: string;
}

export interface VerifySubscriptionBody {
  purchaseToken: string;
  productId: string;
}
