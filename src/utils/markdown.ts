import TurndownService from 'turndown';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

// Remove script, style, nav, footer, header — not useful for notice extraction
turndown.remove(['script', 'style', 'nav', 'footer', 'header', 'aside', 'noscript']);

/**
 * Converts an HTML string to Markdown.
 * Strips non-content elements (nav, scripts, styles, etc.) before conversion.
 */
export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html);
}

/**
 * Truncates a string to at most `maxChars` characters, appending a notice
 * if the content was truncated. Used to cap Markdown before sending to DeepSeek.
 */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n\n[...content truncated for length...]';
}
