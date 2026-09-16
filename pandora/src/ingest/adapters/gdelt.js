import { buildEvent } from '../normalize.js';

/**
 * GDELT 2.0 Document API — https://api.gdeltproject.org/api/v2/doc/doc
 * Free, no key, indexes world news in 65 languages within ~15 minutes.
 *
 * Broad but noisy: it returns headlines with no body text, so classification
 * leans entirely on the title. Treat it as a wide net whose catch goes to a
 * human for curation — exactly the case the review queue exists for.
 */
export default {
  id: 'gdelt',
  label: 'GDELT world news',
  needsKey: false,
  fixture: 'gdelt-articles.json',
  defaultConfig: {
    query: '(port OR shipping OR freight) AND (strike OR closure OR congestion)',
    maxRecords: 50,
    timespan: '1d',
  },
  format: 'json',

  buildUrl(config) {
    const merged = { ...this.defaultConfig, ...config };
    const url = new URL('https://api.gdeltproject.org/api/v2/doc/doc');
    url.searchParams.set('query', merged.query);
    url.searchParams.set('mode', 'artlist');
    url.searchParams.set('format', 'json');
    url.searchParams.set('maxrecords', String(merged.maxRecords));
    url.searchParams.set('timespan', merged.timespan);
    url.searchParams.set('sort', 'datedesc');
    return url.toString();
  },

  parse(payload, { sourceId }) {
    const articles = Array.isArray(payload?.articles) ? payload.articles : [];
    return articles
      .filter((article) => article.title && article.url)
      .map((article) =>
        buildEvent({
          sourceId,
          externalId: article.url,
          title: article.title,
          summary: `Reported by ${article.domain ?? 'unknown source'}.`,
          url: article.url,
          occurredAt: parseSeenDate(article.seendate),
          country: article.sourcecountry || null,
          raw: article,
        }),
      );
  },
};

/** GDELT stamps articles as `20260915T081500Z` — not something Date() reads. */
export function parseSeenDate(value) {
  const match = /^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})Z?$/.exec(String(value ?? ''));
  if (!match) return new Date().toISOString();
  const [, y, mo, d, h, mi, s] = match;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
}
