import { createHash } from 'crypto';

/**
 * Returns a deterministic SHA-256 hex digest of the input string.
 */
export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Creates a deterministic hash for a notice based on title, date, and link.
 * Used to detect duplicate notices across scrape runs.
 */
export function noticeHash(title: string, date: string | null, link: string): string {
  const normalized = [title.trim().toLowerCase(), date?.trim() ?? '', link.trim().toLowerCase()].join(
    '|',
  );
  return sha256(normalized);
}

/**
 * Creates a hash of page content (markdown) to detect whether a page has changed.
 * Used to skip DeepSeek calls when content is identical.
 */
export function contentHash(markdown: string): string {
  return sha256(markdown);
}
