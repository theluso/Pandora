/**
 * A small place-name dictionary.
 *
 * This is what lets a text-only news headline become a geo-located event.
 * A story saying "strike at Rotterdam" carries no coordinates; after this
 * lookup it does, and a subscription watching "500 km around Antwerp" can
 * see it. Expanding this list is the single cheapest way to make matching
 * better — add the places YOUR customers care about.
 *
 * radiusKm = how far the disruption realistically reaches, not map precision.
 */

export const PLACES = [
  // ── Asia ──────────────────────────────────────────────────────────────
  { name: 'Shanghai', aliases: ['Yangshan'], kind: 'port', lat: 30.62, lon: 122.06, country: 'CN', radiusKm: 60 },
  { name: 'Ningbo', aliases: ['Ningbo-Zhoushan', 'Zhoushan'], kind: 'port', lat: 29.87, lon: 121.55, country: 'CN', radiusKm: 60 },
  { name: 'Shenzhen', aliases: ['Yantian', 'Shekou'], kind: 'port', lat: 22.58, lon: 114.27, country: 'CN', radiusKm: 50 },
  { name: 'Guangzhou', aliases: ['Nansha'], kind: 'port', lat: 22.71, lon: 113.62, country: 'CN', radiusKm: 50 },
  { name: 'Qingdao', aliases: [], kind: 'port', lat: 36.07, lon: 120.30, country: 'CN', radiusKm: 50 },
  { name: 'Tianjin', aliases: ['Xingang'], kind: 'port', lat: 38.98, lon: 117.75, country: 'CN', radiusKm: 50 },
  { name: 'Hong Kong', aliases: ['Kwai Tsing'], kind: 'port', lat: 22.34, lon: 114.12, country: 'HK', radiusKm: 40 },
  { name: 'Kaohsiung', aliases: [], kind: 'port', lat: 22.61, lon: 120.28, country: 'TW', radiusKm: 40 },
  { name: 'Busan', aliases: ['Pusan'], kind: 'port', lat: 35.08, lon: 129.08, country: 'KR', radiusKm: 45 },
  { name: 'Singapore', aliases: ['Tuas', 'PSA Singapore'], kind: 'port', lat: 1.26, lon: 103.83, country: 'SG', radiusKm: 45 },
  { name: 'Port Klang', aliases: ['Klang', 'Westports'], kind: 'port', lat: 3.00, lon: 101.39, country: 'MY', radiusKm: 40 },
  { name: 'Tanjung Pelepas', aliases: ['PTP'], kind: 'port', lat: 1.36, lon: 103.55, country: 'MY', radiusKm: 40 },
  { name: 'Laem Chabang', aliases: [], kind: 'port', lat: 13.08, lon: 100.88, country: 'TH', radiusKm: 40 },
  { name: 'Cai Mep', aliases: ['Ho Chi Minh Port', 'Vung Tau'], kind: 'port', lat: 10.53, lon: 107.02, country: 'VN', radiusKm: 45 },
  { name: 'Tanjung Priok', aliases: ['Jakarta Port'], kind: 'port', lat: -6.10, lon: 106.88, country: 'ID', radiusKm: 40 },
  { name: 'Colombo', aliases: [], kind: 'port', lat: 6.95, lon: 79.84, country: 'LK', radiusKm: 40 },
  { name: 'Nhava Sheva', aliases: ['JNPT', 'Jawaharlal Nehru'], kind: 'port', lat: 18.95, lon: 72.95, country: 'IN', radiusKm: 45 },
  { name: 'Mundra', aliases: [], kind: 'port', lat: 22.84, lon: 69.72, country: 'IN', radiusKm: 45 },

  // ── Middle East & Africa ──────────────────────────────────────────────
  { name: 'Jebel Ali', aliases: ['Dubai Port', 'DP World Dubai'], kind: 'port', lat: 25.01, lon: 55.06, country: 'AE', radiusKm: 45 },
  { name: 'Jeddah', aliases: ['King Abdulaziz Port'], kind: 'port', lat: 21.48, lon: 39.17, country: 'SA', radiusKm: 45 },
  { name: 'Salalah', aliases: [], kind: 'port', lat: 16.95, lon: 54.00, country: 'OM', radiusKm: 45 },
  { name: 'Durban', aliases: [], kind: 'port', lat: -29.87, lon: 31.03, country: 'ZA', radiusKm: 45 },
  { name: 'Tanger Med', aliases: ['Tangier'], kind: 'port', lat: 35.88, lon: -5.50, country: 'MA', radiusKm: 45 },
  { name: 'Mombasa', aliases: [], kind: 'port', lat: -4.05, lon: 39.67, country: 'KE', radiusKm: 45 },

  // ── Europe ────────────────────────────────────────────────────────────
  { name: 'Rotterdam', aliases: ['Maasvlakte'], kind: 'port', lat: 51.95, lon: 4.14, country: 'NL', radiusKm: 50 },
  { name: 'Antwerp', aliases: ['Antwerpen', 'Antwerp-Bruges'], kind: 'port', lat: 51.28, lon: 4.32, country: 'BE', radiusKm: 50 },
  { name: 'Hamburg', aliases: [], kind: 'port', lat: 53.53, lon: 9.94, country: 'DE', radiusKm: 50 },
  { name: 'Bremerhaven', aliases: ['Bremen'], kind: 'port', lat: 53.55, lon: 8.57, country: 'DE', radiusKm: 45 },
  { name: 'Valencia', aliases: [], kind: 'port', lat: 39.44, lon: -0.31, country: 'ES', radiusKm: 45 },
  { name: 'Algeciras', aliases: [], kind: 'port', lat: 36.13, lon: -5.44, country: 'ES', radiusKm: 40 },
  { name: 'Barcelona', aliases: [], kind: 'port', lat: 41.34, lon: 2.16, country: 'ES', radiusKm: 40 },
  { name: 'Piraeus', aliases: ['Athens Port'], kind: 'port', lat: 37.94, lon: 23.63, country: 'GR', radiusKm: 40 },
  { name: 'Felixstowe', aliases: [], kind: 'port', lat: 51.95, lon: 1.32, country: 'GB', radiusKm: 40 },
  { name: 'Southampton', aliases: [], kind: 'port', lat: 50.90, lon: -1.42, country: 'GB', radiusKm: 40 },
  { name: 'Le Havre', aliases: [], kind: 'port', lat: 49.48, lon: 0.12, country: 'FR', radiusKm: 45 },
  { name: 'Marseille', aliases: ['Fos-sur-Mer'], kind: 'port', lat: 43.34, lon: 5.05, country: 'FR', radiusKm: 45 },
  { name: 'Gioia Tauro', aliases: [], kind: 'port', lat: 38.45, lon: 15.90, country: 'IT', radiusKm: 40 },
  { name: 'Genoa', aliases: ['Genova'], kind: 'port', lat: 44.40, lon: 8.90, country: 'IT', radiusKm: 40 },
  { name: 'Gdansk', aliases: ['Gdańsk', 'Baltic Hub'], kind: 'port', lat: 54.40, lon: 18.68, country: 'PL', radiusKm: 45 },
  { name: 'Gothenburg', aliases: ['Göteborg'], kind: 'port', lat: 57.69, lon: 11.86, country: 'SE', radiusKm: 40 },

  // ── Americas ──────────────────────────────────────────────────────────
  { name: 'Los Angeles', aliases: ['San Pedro', 'Port of LA'], kind: 'port', lat: 33.73, lon: -118.26, country: 'US', radiusKm: 50 },
  { name: 'Long Beach', aliases: [], kind: 'port', lat: 33.75, lon: -118.20, country: 'US', radiusKm: 50 },
  { name: 'Oakland', aliases: [], kind: 'port', lat: 37.80, lon: -122.33, country: 'US', radiusKm: 40 },
  { name: 'Seattle', aliases: ['Northwest Seaport'], kind: 'port', lat: 47.58, lon: -122.35, country: 'US', radiusKm: 40 },
  { name: 'Tacoma', aliases: [], kind: 'port', lat: 47.27, lon: -122.42, country: 'US', radiusKm: 40 },
  { name: 'New York', aliases: ['New Jersey', 'Newark Bay', 'Port Newark'], kind: 'port', lat: 40.67, lon: -74.14, country: 'US', radiusKm: 55 },
  { name: 'Savannah', aliases: [], kind: 'port', lat: 32.13, lon: -81.14, country: 'US', radiusKm: 45 },
  { name: 'Charleston', aliases: [], kind: 'port', lat: 32.79, lon: -79.92, country: 'US', radiusKm: 45 },
  { name: 'Norfolk', aliases: ['Hampton Roads'], kind: 'port', lat: 36.87, lon: -76.33, country: 'US', radiusKm: 45 },
  { name: 'Houston', aliases: ['Bayport'], kind: 'port', lat: 29.73, lon: -95.27, country: 'US', radiusKm: 55 },
  { name: 'Vancouver', aliases: ['Port Metro Vancouver'], kind: 'port', lat: 49.29, lon: -123.11, country: 'CA', radiusKm: 45 },
  { name: 'Manzanillo', aliases: [], kind: 'port', lat: 19.06, lon: -104.31, country: 'MX', radiusKm: 40 },
  { name: 'Santos', aliases: [], kind: 'port', lat: -23.96, lon: -46.31, country: 'BR', radiusKm: 45 },
  { name: 'Callao', aliases: ['Lima Port'], kind: 'port', lat: -12.05, lon: -77.14, country: 'PE', radiusKm: 40 },
  { name: 'Cartagena', aliases: [], kind: 'port', lat: 10.40, lon: -75.52, country: 'CO', radiusKm: 40 },

  // ── Oceania ───────────────────────────────────────────────────────────
  { name: 'Sydney', aliases: ['Port Botany'], kind: 'port', lat: -33.86, lon: 151.20, country: 'AU', radiusKm: 45 },
  { name: 'Melbourne', aliases: [], kind: 'port', lat: -37.83, lon: 144.92, country: 'AU', radiusKm: 45 },
  { name: 'Auckland', aliases: [], kind: 'port', lat: -36.84, lon: 174.77, country: 'NZ', radiusKm: 40 },

  // ── Chokepoints: small places, outsized consequences ──────────────────
  { name: 'Suez Canal', aliases: ['Suez'], kind: 'chokepoint', lat: 30.58, lon: 32.35, country: 'EG', radiusKm: 130 },
  { name: 'Panama Canal', aliases: ['Gatun', 'Balboa', 'Colon'], kind: 'chokepoint', lat: 9.08, lon: -79.68, country: 'PA', radiusKm: 90 },
  { name: 'Strait of Hormuz', aliases: ['Hormuz'], kind: 'chokepoint', lat: 26.57, lon: 56.25, country: 'OM', radiusKm: 150 },
  { name: 'Bab el-Mandeb', aliases: ['Bab al-Mandab', 'Bab el Mandeb'], kind: 'chokepoint', lat: 12.58, lon: 43.33, country: 'YE', radiusKm: 160 },
  { name: 'Red Sea', aliases: [], kind: 'region', lat: 20.00, lon: 38.50, country: null, radiusKm: 750 },
  { name: 'Strait of Malacca', aliases: ['Malacca Strait'], kind: 'chokepoint', lat: 2.50, lon: 101.50, country: 'MY', radiusKm: 320 },
  { name: 'Bosphorus', aliases: ['Bosporus', 'Turkish Straits', 'Dardanelles'], kind: 'chokepoint', lat: 41.12, lon: 29.07, country: 'TR', radiusKm: 60 },
  { name: 'Strait of Gibraltar', aliases: ['Gibraltar'], kind: 'chokepoint', lat: 35.95, lon: -5.60, country: 'ES', radiusKm: 70 },
  { name: 'Taiwan Strait', aliases: [], kind: 'chokepoint', lat: 24.50, lon: 119.50, country: 'TW', radiusKm: 220 },
  { name: 'Cape of Good Hope', aliases: ['Cape Town'], kind: 'chokepoint', lat: -34.36, lon: 18.47, country: 'ZA', radiusKm: 200 },
  { name: 'Kiel Canal', aliases: ['Nord-Ostsee-Kanal'], kind: 'chokepoint', lat: 54.30, lon: 9.60, country: 'DE', radiusKm: 60 },
  { name: 'Dover Strait', aliases: ['English Channel', 'Strait of Dover'], kind: 'chokepoint', lat: 51.00, lon: 1.50, country: 'GB', radiusKm: 120 },
  { name: 'Rhine', aliases: ['Rhine River', 'Kaub'], kind: 'waterway', lat: 50.09, lon: 7.77, country: 'DE', radiusKm: 200 },
  { name: 'Mississippi River', aliases: ['Lower Mississippi'], kind: 'waterway', lat: 31.50, lon: -91.40, country: 'US', radiusKm: 400 },
];

/** Pre-built lookup: every name and alias, lowercased, pointing at its place. */
const INDEX = new Map();
for (const place of PLACES) {
  for (const label of [place.name, ...place.aliases]) {
    INDEX.set(label.toLowerCase(), place);
  }
}

export function lookupPlace(label) {
  return INDEX.get(String(label).toLowerCase()) ?? null;
}

/**
 * Find every known place mentioned in a block of text.
 * Word-boundary matched so "Cork" never matches inside "Corkscrew".
 */
export function findPlaces(text) {
  if (!text) return [];
  const haystack = ` ${String(text).toLowerCase()} `;
  const hits = new Map();
  for (const [label, place] of INDEX) {
    const pattern = new RegExp(`[^a-z0-9]${label.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}[^a-z0-9]`);
    if (pattern.test(haystack)) {
      // Longer labels win: "Port Klang" beats a bare "Klang" for the same place.
      const existing = hits.get(place.name);
      if (!existing || label.length > existing.matchedOn.length) {
        hits.set(place.name, { ...place, matchedOn: label });
      }
    }
  }
  return [...hits.values()];
}
