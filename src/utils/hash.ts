import { createHash } from 'crypto';

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

// Strip common prefixes ("Notice:", "Circular -"), punctuation, extra whitespace
function normalizeTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/^(notice|circular|announcement|update|alert)\s*[:\-]\s*/i, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Identity = title + resolved link.
 * When link is absent, fall back to title + date (less reliable but better than title alone).
 * Date is intentionally excluded when link is present — AI date formatting is too inconsistent.
 */
export function noticeHash(title: string, link: string, date: string | null): string {
  const normalTitle = normalizeTitle(title);
  const normalLink = link.trim().toLowerCase();
  const parts = normalLink
    ? [normalTitle, normalLink]
    : [normalTitle, date?.trim().toLowerCase() ?? ''];
  return sha256(parts.join('|'));
}

export function contentHash(markdown: string): string {
  return sha256(markdown);
}

// Deterministic, stable sourceId from a URL
export function urlHash(url: string): string {
  return sha256(url.trim().toLowerCase());
}
