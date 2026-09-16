import { all, run, parseJson } from '../db.js';
import { textOf } from './engine.js';

/**
 * ============================================================================
 * CURATION RULES — how a human makes the matcher smarter
 * ============================================================================
 * The scoring engine is generic. Rules are where YOUR domain knowledge lands:
 *
 *   boost    — "anything mentioning 'berth closure' matters more to us"  (+w)
 *   suppress — "this outlet over-reports, weight it down"                (−w)
 *   block    — "never send me anything from this domain"                (hard no)
 *   require  — "only send me things that mention one of these"           (hard gate)
 *
 * A rule attached to a subscription applies only there; a rule with no
 * subscription is global. Curators write them by hand, or the system offers
 * one when a rejection looks like a pattern.
 * ============================================================================
 */

export function activeRulesFor(subscriptionId) {
  return all(
    `SELECT * FROM rules
      WHERE active = 1 AND (subscription_id IS NULL OR subscription_id = ?)
      ORDER BY subscription_id IS NULL, created_at`,
    subscriptionId,
  );
}

/** Does this rule's target/value describe this event? */
export function ruleMatches(rule, event, source) {
  const value = String(rule.value).toLowerCase();
  switch (rule.target) {
    case 'keyword':
      return textOf(event).includes(value);
    case 'category':
      return String(event.category).toLowerCase() === value;
    case 'source':
      return String(source?.id ?? '').toLowerCase() === value
        || String(source?.adapter ?? '').toLowerCase() === value
        || String(source?.name ?? '').toLowerCase() === value;
    case 'domain':
      return String(event.url ?? '').toLowerCase().includes(value);
    case 'place':
      return parseJson(event.entities, []).some((e) => String(e.name).toLowerCase() === value)
        || String(event.place_name ?? '').toLowerCase().includes(value);
    case 'country':
      return String(event.country ?? '').toLowerCase() === value;
    default:
      return false;
  }
}

/**
 * Apply every relevant rule to a base score.
 * Returns the adjusted score, the reasons, and whether a rule vetoed it.
 */
export function applyRules(baseScore, event, source, rules) {
  let score = baseScore;
  const applied = [];
  let blocked = null;

  const requireRules = rules.filter((r) => r.kind === 'require');
  if (requireRules.length) {
    const satisfied = requireRules.some((rule) => ruleMatches(rule, event, source));
    if (!satisfied) {
      const list = requireRules.map((r) => `${r.target}:${r.value}`).join(' or ');
      return {
        score: 0,
        applied,
        blocked: { rule: requireRules[0], detail: `no required signal present (needs ${list})` },
      };
    }
    applied.push({
      ruleId: requireRules.find((r) => ruleMatches(r, event, source)).id,
      kind: 'require',
      detail: 'required signal present',
      delta: 0,
    });
  }

  for (const rule of rules) {
    if (rule.kind === 'require') continue;
    if (!ruleMatches(rule, event, source)) continue;

    if (rule.kind === 'block') {
      blocked = { rule, detail: `blocked by rule: ${rule.target} = "${rule.value}"${rule.note ? ` (${rule.note})` : ''}` };
      break;
    }

    const delta = rule.kind === 'boost' ? rule.weight : -rule.weight;
    score = Math.min(1, Math.max(0, score + delta));
    applied.push({
      ruleId: rule.id,
      kind: rule.kind,
      detail: `${rule.kind} on ${rule.target} "${rule.value}"${rule.note ? ` — ${rule.note}` : ''}`,
      delta: Number(delta.toFixed(3)),
    });
  }

  if (blocked) return { score: 0, applied, blocked };

  // Count usage so a curator can see which rules actually earn their keep.
  for (const entry of applied) {
    if (entry.ruleId) run('UPDATE rules SET hits = hits + 1 WHERE id = ?', entry.ruleId);
  }

  return { score, applied, blocked: null };
}
