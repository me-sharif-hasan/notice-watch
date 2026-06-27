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

export async function cacheSet(key: string, value: unknown, ttl: number): Promise<void> {
  try {
    await getRedis().set(key, JSON.stringify(value), 'EX', ttl);
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
