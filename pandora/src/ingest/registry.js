import usgs from './adapters/usgs.js';
import nws from './adapters/nws.js';
import rss from './adapters/rss.js';
import gdelt from './adapters/gdelt.js';

/**
 * Every adapter the system knows about.
 *
 * To add a new kind of source: drop a file in ./adapters that exports
 * { id, label, format, defaultConfig, buildUrl(config), parse(payload, ctx) }
 * and register it here. Nothing else in the codebase needs to change.
 */
export const ADAPTERS = Object.fromEntries(
  [usgs, nws, rss, gdelt].map((adapter) => [adapter.id, adapter]),
);

export function getAdapter(id) {
  const adapter = ADAPTERS[id];
  if (!adapter) throw new Error(`Unknown adapter "${id}". Known: ${Object.keys(ADAPTERS).join(', ')}`);
  return adapter;
}
