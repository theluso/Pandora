const EARTH_RADIUS_KM = 6371;
const toRad = (deg) => (deg * Math.PI) / 180;

/** Great-circle distance in kilometres. */
export function distanceKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Does an event touch a watched circle?
 * The event carries its own radius (a storm covers a region, a quake shakes
 * an area), so we compare centre-to-centre distance against the SUM of radii.
 */
export function circlesOverlap(event, watch) {
  if (!Number.isFinite(event.lat) || !Number.isFinite(event.lon)) return null;
  const gap = distanceKm(event.lat, event.lon, watch.lat, watch.lon);
  const reach = (watch.radius_km ?? 100) + (event.radius_km ?? 0);
  return { overlaps: gap <= reach, distanceKm: gap, reachKm: reach };
}
