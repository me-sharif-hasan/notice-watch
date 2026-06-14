import { URL } from 'url';

/**
 * Private/reserved IP ranges that must not be scraped.
 * Prevents SSRF attacks via the Playwright scraper.
 */
const PRIVATE_IP_PATTERNS = [
  /^127\./,           // Loopback
  /^10\./,            // Private Class A
  /^192\.168\./,      // Private Class B
  /^172\.(1[6-9]|2\d|3[01])\./,  // Private Class C (172.16–172.31)
  /^169\.254\./,      // Link-local (APIPA)
  /^0\./,             // "This" network
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,  // CGNAT (RFC 6598)
  /^::1$/,            // IPv6 loopback
  /^fc[0-9a-f]{2}:/i, // IPv6 ULA
  /^fe80:/i,          // IPv6 link-local
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal', // GCP metadata endpoint
  '169.254.169.254',           // AWS/Azure metadata endpoint
]);

/**
 * Validates that a URL is safe to scrape.
 *
 * Throws an error if:
 * - The URL is not a valid URL
 * - The scheme is not HTTP or HTTPS
 * - The hostname resolves to a private/reserved IP
 * - The hostname is in the blocked list
 */
export function validateUrl(rawUrl: string): void {
  let parsed: URL;

  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: "${rawUrl}"`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`URL must use HTTP or HTTPS. Got: "${parsed.protocol}"`);
  }

  const hostname = parsed.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error(`URL hostname "${hostname}" is not allowed`);
  }

  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(hostname)) {
      throw new Error(`URL resolves to a private/reserved IP range: "${hostname}"`);
    }
  }
}
