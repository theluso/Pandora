import { buildEvent } from '../normalize.js';
import { parseFeed } from '../../lib/xml.js';

/**
 * Generic RSS/Atom adapter — the workhorse.
 *
 * Almost every trade publication, port authority, customs agency and
 * government department publishes RSS. Add a source row pointing at a feed
 * URL and you have a new signal stream with no code change. This is where
 * the long tail of coverage comes from.
 *
 * Unlike USGS/NWS, nothing here is pre-labelled: category, severity and
 * location are all inferred from the text by the normaliser.
 */
export default {
  id: 'rss',
  label: 'RSS / Atom feed',
  needsKey: false,
  fixture: 'maritime-rss.xml',
  defaultConfig: { url: '', keywordsAny: [] },
  format: 'text',

  buildUrl(config) {
    if (!config.url) throw new Error('RSS source requires a `url` in its config');
    return config.url;
  },

  parse(payload, { sourceId, config = {} }) {
    const keywords = (config.keywordsAny ?? []).map((k) => k.toLowerCase());

    return parseFeed(payload)
      .filter((item) => item.title)
      .filter((item) => {
        // Optional pre-filter: only keep items mentioning something we care
        // about. Cuts a general news feed down to the relevant slice.
        if (!keywords.length) return true;
        const haystack = `${item.title} ${item.description}`.toLowerCase();
        return keywords.some((k) => haystack.includes(k));
      })
      .map((item) =>
        buildEvent({
          sourceId,
          externalId: item.guid || item.link,
          title: item.title,
          summary: item.description,
          url: item.link,
          occurredAt: item.pubDate,
          raw: item,
        }),
      );
  },
};
