import OpenAI from 'openai';
import type { RawNotice } from '../types/index.js';

// ─── Client ───────────────────────────────────────────────────────────────────

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY ?? '',
  baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1',
});

const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat';

// ─── Prompt Template ──────────────────────────────────────────────────────────

function buildPrompt(markdown: string, userPrompt: string): string {
  return `You are a notice extraction assistant. Extract notices from the following webpage content that are relevant to the user's tracking criteria.

User's tracking criteria:
${userPrompt}

Webpage content (in Markdown):
---
${markdown}
---

Instructions:
- Extract ONLY notices matching the user's criteria.
- Return a valid JSON array and NOTHING else — no explanation, no markdown fences.
- Each item must have these fields: title, summary, date, link.
- Use null for date or link if not available.
- If no relevant notices are found, return an empty array: []

Required JSON format:
[
  {
    "title": "string",
    "summary": "string",
    "date": "string or null",
    "link": "string or null"
  }
]`;
}

// ─── Extraction ───────────────────────────────────────────────────────────────

/**
 * Calls DeepSeek to extract notices from the given Markdown content that are
 * relevant to the user-provided prompt.
 *
 * Returns an empty array if the response cannot be parsed as valid JSON.
 */
export async function extractNotices(markdown: string, userPrompt: string): Promise<RawNotice[]> {
  const prompt = buildPrompt(markdown, userPrompt);

  let raw: string;

  try {
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1, // Low temperature for deterministic extraction
      max_tokens: 4096,
    });

    raw = completion.choices[0]?.message?.content?.trim() ?? '';
  } catch (err) {
    console.error('[DeepSeek] API call failed:', err);
    throw err;
  }

  // Strip accidental markdown code fences if model wraps output
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    const parsed = JSON.parse(cleaned) as unknown;

    if (!Array.isArray(parsed)) {
      console.warn('[DeepSeek] Response is not an array, returning []');
      return [];
    }

    return parsed
      .filter((item): item is RawNotice => {
        return (
          typeof item === 'object' &&
          item !== null &&
          typeof (item as RawNotice).title === 'string' &&
          typeof (item as RawNotice).summary === 'string'
        );
      })
      .map((item: RawNotice) => ({
        title: item.title,
        summary: item.summary,
        date: typeof item.date === 'string' ? item.date : null,
        link: typeof item.link === 'string' ? item.link : null,
      }));
  } catch (err) {
    console.error('[DeepSeek] Failed to parse response as JSON:', cleaned, err);
    return [];
  }
}
