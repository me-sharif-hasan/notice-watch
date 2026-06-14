import { chromium, Browser, BrowserContext } from 'playwright';
import { validateUrl } from '../utils/url-validator.js';

// ─── Browser Singleton ────────────────────────────────────────────────────────

let _browser: Browser | null = null;
let _launchPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (_browser?.isConnected()) return _browser;

  // Prevent multiple concurrent launch calls
  if (_launchPromise) return _launchPromise;

  _launchPromise = chromium
    .launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
      ],
    })
    .then((b) => {
      _browser = b;
      _launchPromise = null;

      b.on('disconnected', () => {
        console.warn('[Playwright] Browser disconnected, will relaunch on next request');
        _browser = null;
      });

      return b;
    });

  return _launchPromise;
}

/**
 * Gracefully closes the shared Playwright browser instance.
 * Call this during application shutdown.
 */
export async function closeBrowser(): Promise<void> {
  if (_browser?.isConnected()) {
    await _browser.close();
    _browser = null;
  }
}

// ─── Page Rendering ───────────────────────────────────────────────────────────

const TIMEOUT_MS = parseInt(process.env.PLAYWRIGHT_TIMEOUT_MS ?? '30000', 10);

/**
 * Renders a webpage using Playwright and returns the full HTML content.
 *
 * - Validates the URL against SSRF blocklist before loading
 * - Waits for networkidle to capture dynamic content
 * - Applies a configurable timeout
 * - Each call gets its own isolated BrowserContext (no cookie/session leakage)
 */
export async function renderPage(url: string): Promise<string> {
  // SSRF guard — throws if URL is private/internal
  validateUrl(url);

  const browser = await getBrowser();
  let context: BrowserContext | null = null;

  try {
    context = await browser.newContext({
      // Mimic a real browser to avoid bot detection
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      javaScriptEnabled: true,
      // Block images/fonts/media to reduce bandwidth and speed up scraping
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });

    const page = await context.newPage();

    // Block unnecessary resource types to save bandwidth
    await page.route('**/*', (route) => {
      const resourceType = route.request().resourceType();
      if (['image', 'font', 'media', 'stylesheet'].includes(resourceType)) {
        return route.abort();
      }
      return route.continue();
    });

    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: TIMEOUT_MS,
    });

    const html = await page.content();
    return html;
  } finally {
    await context?.close();
  }
}
