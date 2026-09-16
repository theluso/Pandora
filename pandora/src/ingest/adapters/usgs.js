import { buildEvent } from '../normalize.js';

/**
 * USGS earthquake feed — https://earthquake.usgs.gov/earthquakes/feed/
 * Free, no key, worldwide, updated every minute. The cleanest structured
 * hazard feed on the public internet and a good first source to trust.
 */

/** Magnitude → our 1–5 severity, and how far the shaking realistically matters. */
function fromMagnitude(mag) {
  if (mag >= 7.5) return { severity: 5, radiusKm: 600 };
  if (mag >= 6.5) return { severity: 5, radiusKm: 400 };
  if (mag >= 5.5) return { severity: 4, radiusKm: 250 };
  if (mag >= 4.5) return { severity: 3, radiusKm: 150 };
  return { severity: 2, radiusKm: 80 };
}

export default {
  id: 'usgs',
  label: 'USGS Earthquakes',
  needsKey: false,
  fixture: 'usgs-earthquakes.json',
  defaultConfig: {
    url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson',
  },
  format: 'json',

  buildUrl(config) {
    return config.url ?? this.defaultConfig.url;
  },

  parse(payload, { sourceId }) {
    const features = Array.isArray(payload?.features) ? payload.features : [];
    return features.map((feature) => {
      const props = feature.properties ?? {};
      const [lon, lat, depthKm] = feature.geometry?.coordinates ?? [];
      const mag = Number(props.mag);
      const scale = fromMagnitude(mag);
      const tsunami = props.tsunami === 1;

      return buildEvent({
        sourceId,
        externalId: feature.id ?? props.code,
        title: props.title ?? `M ${mag} — ${props.place ?? 'unknown location'}`,
        summary:
          `Magnitude ${mag} earthquake${props.place ? ` ${props.place}` : ''}, ` +
          `depth ${Number.isFinite(depthKm) ? depthKm.toFixed(0) : '?'} km.` +
          (tsunami ? ' Tsunami evaluation was triggered for this event.' : ''),
        url: props.url,
        occurredAt: props.time,
        category: 'earthquake',
        severity: tsunami ? Math.min(5, scale.severity + 1) : scale.severity,
        confidence: 0.95,
        lat,
        lon,
        radiusKm: scale.radiusKm,
        placeName: props.place ?? null,
        raw: feature,
      });
    });
  },
};
