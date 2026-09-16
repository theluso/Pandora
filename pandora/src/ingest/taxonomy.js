/**
 * The vocabulary of the product.
 *
 * Everything flowing through Pandora is reduced to ONE category and ONE
 * severity, because that is what lets an agent write `if severity >= 4` and
 * trust it. Keep this list short on purpose — a taxonomy nobody can hold in
 * their head is a taxonomy nobody filters on.
 */

export const CATEGORIES = [
  'port_disruption',
  'congestion',
  'labor_action',
  'weather',
  'earthquake',
  'flood',
  'wildfire',
  'security',
  'regulatory',
  'infrastructure',
  'cyber',
  'health',
  'other',
];

export const SEVERITY = {
  1: 'info',
  2: 'minor',
  3: 'moderate',
  4: 'major',
  5: 'critical',
};

export const severityName = (n) => SEVERITY[n] ?? 'unknown';
export const severityValue = (name) =>
  Number(Object.entries(SEVERITY).find(([, label]) => label === name)?.[0] ?? name) || 0;

/**
 * ── HOW SIGNAL PHRASES ARE MATCHED ──────────────────────────────────────
 * Every phrase below is compiled to a WORD-BOUNDARY regex, never a plain
 * substring. This is not fussiness — a plain `text.includes('port')` matches
 * the word "reported", which silently labelled every wire story a port
 * disruption. Word boundaries are the difference between a classifier and a
 * random number generator.
 *
 * A trailing `*` means "this stem plus any ending":
 *     'clos*'   matches close, closed, closing, closure, closures
 *     'port'    matches port, Port — but NOT reported, portfolio, transport
 * Multi-word phrases tolerate punctuation AND up to two filler words, so
 * 'port clos*' matches "port closure", "port-closing", "port is closed" and
 * "port has been closed" — the ways a real headline actually says it.
 * ─────────────────────────────────────────────────────────────────────────
 */
const COMPILED = new Map();

export function compileSignal(signal) {
  const cached = COMPILED.get(signal);
  if (cached) return cached;

  const parts = signal.trim().split(/\s+/).map((word) => {
    const isStem = word.endsWith('*');
    const core = (isStem ? word.slice(0, -1) : word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return isStem ? `${core}\\w*` : core;
  });

  // Between phrase words: punctuation, optionally with up to two small words
  // in the way ("is", "has been"). Two is the sweet spot — enough for real
  // headlines, few enough that the match stays inside one clause.
  const gap = '(?:\\W+\\w+){0,2}\\W+';
  const regex = new RegExp(`\\b${parts.join(gap)}\\b`, 'i');
  COMPILED.set(signal, regex);
  return regex;
}

export const matchesSignal = (text, signal) => compileSignal(signal).test(text);

/**
 * Category signals. Weight reflects how strongly a phrase implies the
 * category — "berth closure" is decisive, "terminal" is only a hint.
 */
export const CATEGORY_SIGNALS = {
  port_disruption: [
    ['port clos*', 3], ['port shut*', 3], ['berth clos*', 3], ['terminal clos*', 3],
    ['suspend* operations', 3], ['halt* operations', 3], ['port disrupt*', 3],
    ['closed to shipping', 3], ['crane collapse*', 3], ['port reopen*', 2],
    ['loading suspend*', 2], ['vessel* divert*', 2], ['secure* all* cranes', 2],
    ['gate* clos*', 2], ['terminal*', 1], ['harbour*', 1], ['harbor*', 1], ['port*', 1],
  ],
  congestion: [
    ['congest*', 3], ['backlog*', 3], ['queue of vessel*', 3], ['vessel queue*', 3],
    ['waiting time*', 2], ['bottleneck*', 2], ['anchorage*', 2], ['dwell time*', 2],
    ['berth delay*', 3], ['at anchor', 2], ['yard density', 2], ['truck turn time*', 2],
  ],
  labor_action: [
    ['strike*', 3], ['walkout*', 3], ['walk* out', 3], ['work stoppage*', 3],
    ['industrial action', 3], ['picket*', 2], ['union*', 1], ['labour dispute*', 3],
    ['labor dispute*', 3], ['go-slow', 2], ['lockout*', 2], ['dockworker*', 2], ['docker*', 2],
  ],
  weather: [
    ['typhoon*', 3], ['hurricane*', 3], ['cyclone*', 3], ['storm surge', 3],
    ['gale*', 3], ['blizzard*', 2], ['high wind*', 2], ['dense fog', 3], ['fog', 2],
    ['severe weather', 3], ['tropical storm*', 3], ['heavy rain*', 2], ['heat wave*', 2],
    ['landfall', 2], ['gust*', 2],
  ],
  earthquake: [['earthquake*', 3], ['seismic', 2], ['magnitude', 2], ['aftershock*', 2], ['tsunami*', 3]],
  flood: [['flood*', 3], ['inundat*', 2], ['river level*', 2], ['low water', 3], ['drought*', 2], ['barge draft*', 2]],
  wildfire: [['wildfire*', 3], ['bushfire*', 3], ['forest fire*', 3]],
  security: [
    ['piracy', 3], ['pirate*', 3], ['hijack*', 3], ['missile*', 3], ['drone*', 3],
    ['attack*', 3], ['armed conflict', 3], ['seiz*', 2], ['blockade*', 3],
    ['terror*', 3], ['unrest', 2], ['protest*', 2], ['war risk', 3], ['shelling', 3],
  ],
  regulatory: [
    ['sanction*', 3], ['tariff*', 3], ['embargo*', 3], ['customs', 2], ['export control*', 3],
    ['new regulation*', 3], ['regulation*', 2], ['ban*', 2], ['quota*', 2],
    ['inspection*', 2], ['compliance', 1], ['port call*', 2],
  ],
  infrastructure: [
    ['canal*', 2], ['bridge collapse*', 3], ['rail disruption*', 3], ['derail*', 3],
    ['power outage*', 3], ['pipeline*', 2], ['airport clos*', 3], ['runway*', 2],
    ['road clos*', 2], ['lock failure*', 3], ['draft restriction*', 3], ['maximum draft', 3],
    ['transit restriction*', 3], ['signal* failure', 3], ['lock*', 1],
  ],
  cyber: [['ransomware', 3], ['cyberattack*', 3], ['cyber attack*', 3], ['data breach*', 2], ['system* offline', 3], ['it system*', 2]],
  health: [['outbreak*', 3], ['quarantine*', 3], ['epidemic*', 3], ['pandemic*', 3], ['contaminat*', 2]],
};

/**
 * Severity signals, strongest first. The highest level that matches wins.
 * Stems matter here more than anywhere: "close", "closed", "closing" and
 * "closure" all mean the same thing operationally.
 */
export const SEVERITY_SIGNALS = [
  [5, ['catastroph*', 'mass casualt*', 'total closure', 'indefinitely', 'state of emergency',
       'complete shutdown', 'force majeure', 'all vessel movement*', 'evacuat*']],
  [4, ['clos*', 'shut*', 'suspend*', 'halt*', 'major disruption', 'severe', 'blockade*',
       'fatalit*', 'attack*', 'hijack*', 'derail*', 'collapse*', 'ransomware', 'strike*',
       'walkout*', 'stoppage*', 'warning']],
  [3, ['disrupt*', 'delay*', 'restrict*', 'congest*', 'backlog*', 'divert*', 'queue*',
       'moderate', 'partial*', 'reduce*', 'cut*', 'surcharge*']],
  [2, ['minor', 'brief*', 'expected to resume', 'watch', 'advisory', 'possible']],
  [1, ['no impact', 'unaffected']],
];

/**
 * Category floors. Some categories are never trivial: a drone attack on a
 * ship is at minimum "moderate" even if the wording is calm ("crew safe").
 * Without this, careful reporting reads as a non-event.
 */
export const CATEGORY_SEVERITY_FLOOR = {
  security: 3,
  cyber: 3,
  port_disruption: 3,
  labor_action: 3,
  earthquake: 2,
  congestion: 2,
};

/**
 * Recovery language. "Reopened", "back to normal" — the story is about a
 * disruption ENDING, so it should not page anyone at severity 5. We cap
 * rather than zero it: the fact a port has reopened is still worth knowing.
 */
export const RECOVERY_SIGNALS = [
  'reopen*', 'resume*', 'back to normal', 'normal operations', 'clear*', 'lifted', 'restored',
];
export const RECOVERY_CAP = 3;

/** Phrases that mean "this is background noise", not an operational event. */
export const NOISE_SIGNALS = [
  'opinion', 'op-ed', 'analysis', 'interview*', 'podcast*', 'webinar*', 'appoint*',
  'quarterly result*', 'earnings', 'awarded contract*', 'names new', 'celebrat*',
  'anniversary', 'sponsored', 'advertisement', 'obituary', 'profile*',
];
