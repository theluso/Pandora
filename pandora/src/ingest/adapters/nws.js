import { buildEvent } from '../normalize.js';

/**
 * US National Weather Service active alerts — https://api.weather.gov/alerts/active
 * Free, no key. US-only, but the model is the CAP standard, so the same
 * adapter shape works for Meteoalarm (EU) and most national met services.
 */

const SEVERITY_MAP = { Extreme: 5, Severe: 4, Moderate: 3, Minor: 2, Unknown: 2 };

/** Events the NWS issues that actually move freight. */
const LOGISTICS_RELEVANT = /wind|gale|storm|hurricane|flood|winter|ice|freez|fog|surge|tornado|blizzard|heat/i;

export default {
  id: 'nws',
  label: 'NWS Weather Alerts (US)',
  needsKey: false,
  fixture: 'nws-alerts.json',
  defaultConfig: {
    url: 'https://api.weather.gov/alerts/active',
    severityAtLeast: 'Moderate',
  },
  format: 'json',

  buildUrl(config) {
    const base = config.url ?? this.defaultConfig.url;
    const url = new URL(base);
    if (config.area) url.searchParams.set('area', config.area);
    if (config.limit) url.searchParams.set('limit', String(config.limit));
    return url.toString();
  },

  parse(payload, { sourceId }) {
    const features = Array.isArray(payload?.features) ? payload.features : [];
    return features
      .filter((feature) => LOGISTICS_RELEVANT.test(feature.properties?.event ?? ''))
      .map((feature) => {
        const props = feature.properties ?? {};
        const point = centroidOf(feature.geometry);

        return buildEvent({
          sourceId,
          externalId: props.id,
          title: props.headline || `${props.event} — ${props.areaDesc}`,
          summary: (props.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 1200),
          url: props['@id'] ?? props.id,
          occurredAt: props.effective ?? props.sent,
          expiresAt: props.expires ?? props.ends,
          category: 'weather',
          severity: SEVERITY_MAP[props.severity] ?? 3,
          confidence: 0.9,
          lat: point?.lat ?? null,
          lon: point?.lon ?? null,
          radiusKm: point?.radiusKm ?? 120,
          placeName: props.areaDesc ?? null,
          country: 'US',
          raw: feature,
        });
      });
  },
};

/**
 * Alerts carry a polygon, not a point. We reduce it to a centre plus a radius
 * that covers the whole shape — good enough for "does this touch my circle?",
 * and far cheaper than full polygon intersection.
 */
export function centroidOf(geometry) {
  if (!geometry) return null;
  const rings =
    geometry.type === 'Polygon' ? geometry.coordinates
    : geometry.type === 'MultiPolygon' ? geometry.coordinates.flat()
    : null;
  if (!rings?.length) return null;

  const points = rings.flat().filter((p) => Array.isArray(p) && p.length >= 2);
  if (!points.length) return null;

  const lon = points.reduce((sum, p) => sum + p[0], 0) / points.length;
  const lat = points.reduce((sum, p) => sum + p[1], 0) / points.length;

  // Radius = furthest vertex from the centre, in km (1° lat ≈ 111 km).
  const radiusKm = Math.max(
    25,
    ...points.map((p) => {
      const dLat = (p[1] - lat) * 111;
      const dLon = (p[0] - lon) * 111 * Math.cos((lat * Math.PI) / 180);
      return Math.sqrt(dLat * dLat + dLon * dLon);
    }),
  );

  return { lat, lon, radiusKm: Math.round(radiusKm) };
}
