import { getRedis } from './redis.js';

const TTL = {
  user: 60,      // seconds
  trackers: 30,
};

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const val = await getRedis().get(key);
    return val ? (JSON.parse(val) as T) : null;
  } catch {
    return null;
  }
}

function serialize(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v !== null && typeof v === 'object' && typeof v._seconds === 'number' && typeof v._nanoseconds === 'number') {
      return new Date(v._seconds * 1000 + v._nanoseconds / 1e6).toISOString();
    }
    return v;
  });
}

export async function cacheSet(key: string, value: unknown, ttl: number): Promise<void> {
  try {
    await getRedis().set(key, serialize(value), 'EX', ttl);
  } catch { /* non-fatal */ }
}

export async function cacheDel(...keys: string[]): Promise<void> {
  try {
    if (keys.length) await getRedis().del(...keys);
  } catch { /* non-fatal */ }
}

export const CacheKey = {
  user: (uid: string) => `user:${uid}`,
  trackers: (uid: string) => `trackers:${uid}`,
};

export { TTL };
