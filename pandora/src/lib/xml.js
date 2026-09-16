/**
 * A deliberately small RSS/Atom reader.
 *
 * Why not a library? News feeds use a tiny, stable subset of XML and we only
 * ever read it — never round-trip it. ~80 lines here beats a dependency we
 * would have to keep patched.
 */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'", '#8217': '’',
};

export function decodeEntities(text) {
  return String(text)
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, code) => {
      if (ENTITIES[code] !== undefined) return ENTITIES[code];
      if (code[0] === '#') {
        const value = code[1] === 'x' || code[1] === 'X'
          ? parseInt(code.slice(2), 16)
          : parseInt(code.slice(1), 10);
        return Number.isFinite(value) ? String.fromCodePoint(value) : whole;
      }
      return whole;
    });
}

export function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function unwrap(raw) {
  const cdata = raw.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return decodeEntities(cdata ? cdata[1] : raw).trim();
}

/** First value of <tag>…</tag> inside a chunk, CDATA-aware. */
export function tagText(chunk, ...names) {
  for (const name of names) {
    const match = chunk.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
    if (match) return unwrap(match[1]);
  }
  return '';
}

/** Value of an attribute on the first matching self-closing/open tag. */
export function tagAttr(chunk, name, attr) {
  const match = chunk.match(new RegExp(`<${name}\\s[^>]*${attr}=["']([^"']+)["']`, 'i'));
  return match ? decodeEntities(match[1]) : '';
}

/** Split a feed document into its <item> (RSS) or <entry> (Atom) chunks. */
export function feedItems(xml) {
  const items = [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);
  if (items.length) return items;
  return [...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)].map((m) => m[1]);
}

export function parseFeed(xml) {
  return feedItems(xml).map((chunk) => {
    const link = tagText(chunk, 'link') || tagAttr(chunk, 'link', 'href');
    return {
      title: stripTags(tagText(chunk, 'title')),
      link,
      guid: tagText(chunk, 'guid', 'id') || link,
      description: stripTags(tagText(chunk, 'description', 'summary', 'content:encoded', 'content')),
      pubDate: tagText(chunk, 'pubDate', 'published', 'updated', 'dc:date'),
      categories: [...chunk.matchAll(/<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/gi)]
        .map((m) => stripTags(m[1]))
        .filter(Boolean),
    };
  });
}
