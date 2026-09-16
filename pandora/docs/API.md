# Pandora API reference

Base URL when running locally: `http://127.0.0.1:4180`

Every endpoint except `/healthz` needs a key:

```
Authorization: Bearer pnd_your_key_here
```

Two kinds of key:

- **agent** — manages its own subscriptions, reads its own events
- **curator (admin)** — everything above, plus the review queue, sources,
  rules, other subscribers and pipeline control

Errors are always JSON and say what was wrong:

```json
{ "error": "`filter.minSeverity` must be an integer from 1 to 5" }
```

`400` bad input · `401` no/unknown key · `403` not allowed · `404` not found

---

## Quick reference

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/healthz` | anyone | Liveness + ingest mode |
| GET | `/v1/me` | any key | Who am I |
| GET | `/v1/catalog` | any key | Categories, severities, sources, review modes |
| GET | `/v1/events` | any key | **The pull feed** |
| GET | `/v1/events/:id` | any key | One event |
| POST | `/v1/events/:id/feedback` | any key | "useful" / "not useful" |
| GET | `/v1/subscriptions` | any key | List your subscriptions |
| POST | `/v1/subscriptions` | any key | Create one |
| GET | `/v1/subscriptions/:id` | owner | Read one |
| PATCH | `/v1/subscriptions/:id` | owner | Update one |
| DELETE | `/v1/subscriptions/:id` | owner | Delete one |
| POST | `/v1/subscriptions/:id/test` | owner | **Dry run against history** |
| GET | `/v1/curation/queue` | curator | Items awaiting review |
| POST | `/v1/curation/matches/:id/approve` | curator | Approve (optionally edited) |
| POST | `/v1/curation/matches/:id/reject` | curator | Reject (optionally + rule) |
| POST | `/v1/curation/bulk` | curator | Approve/reject many |
| GET | `/v1/curation/history` | curator | Decision audit trail |
| GET/POST/PATCH/DELETE | `/v1/rules[/:id]` | curator | Curation rules |
| GET/POST/PATCH/DELETE | `/v1/sources[/:id]` | curator | Sources |
| GET/POST | `/v1/admin/subscribers` | curator | List / mint API keys |
| POST | `/v1/admin/run` | curator | Run the pipeline now |
| GET | `/v1/admin/stats` | curator | System counters |
| GET | `/v1/admin/deliveries` | curator | Delivery log |

---

## The filter object

Everything a subscription can ask for. All fields optional; an empty filter
matches everything.

| Field | Type | Meaning |
|---|---|---|
| `categories` | string[] | Only these categories. **Hard gate.** |
| `minSeverity` | 1–5 | At least this severe. **Hard gate.** |
| `minConfidence` | 0–1 | Only parses we are at least this sure of. **Hard gate.** |
| `keywordsAll` | string[] | Every one must appear. **Hard gate.** |
| `keywordsNone` | string[] | None may appear. **Hard gate.** |
| `keywordsAny` | string[] | Scored: more hits, higher score. |
| `places` | string[] | Named places from the gazetteer, e.g. `"Rotterdam"`. |
| `countries` | string[] | ISO-2 codes, e.g. `["NL","BE"]`. |
| `near` | object[] | `{ lat, lon, radiusKm, label }` watch circles. |
| `geoMatch` | `"any"` \| `"all"` | How geo constraints combine. Default `"any"`. |
| `geoStrict` | boolean | Default `true`: reject events definitely elsewhere. |
| `sources` | string[] | Source ids or adapter names. **Hard gate.** |

### `geoMatch` — read this one carefully

It is the field most likely to surprise you.

```jsonc
// "any" (default) — Rotterdam OR Antwerp OR within 600 km of Hamburg
{ "places": ["Rotterdam", "Antwerp"], "near": [{ "lat": 53.55, "lon": 9.94, "radiusKm": 600 }] }

// "all" — in the US *AND* within 400 km of Houston
{ "countries": ["US"], "near": [{ "lat": 29.73, "lon": -95.27, "radiusKm": 400 }], "geoMatch": "all" }
```

With the default `"any"`, a Los Angeles storm satisfies `countries: ["US"]` on
its own and lands in a Gulf Coast customer's feed. If your constraints are
meant to narrow each other rather than widen the net, say `"all"`.

**How a watch circle is matched.** An event carries its own radius — a
hurricane covers a region, an earthquake shakes an area. Overlap is
centre-to-centre distance against the *sum* of both radii, so a storm whose
edge reaches your port counts even if its centre does not.

**Events with no known location** score 0.35 rather than being rejected —
uncertain, not irrelevant — so a human sees them in `hybrid` or `review` mode.

---

## Endpoints

### `GET /v1/events` — the pull feed

The endpoint most integrations live on.

| Query | Default | Meaning |
|---|---|---|
| `limit` | 50 | Max 200 |
| `cursor` | — | `next_cursor` from your last page |
| `since` | — | ISO timestamp; only events on/after it |
| `subscription_id` | — | One subscription only |
| `category` | — | Filter by category |
| `min_severity` | — | Filter by severity |

```json
{
  "events": [{
    "id": "evt_mu48tqcz",
    "title": "Dockworkers begin 48-hour walkout at Port of Rotterdam",
    "summary": "Container operations suspended.",
    "url": "https://…",
    "category": "labor_action",
    "severity": 4,
    "confidence": 0.86,
    "occurred_at": "2026-09-15T07:15:00Z",
    "ingested_at": "2026-09-15T07:31:02Z",
    "expires_at": null,
    "location": { "lat": 51.95, "lon": 4.14, "radius_km": 50, "place": "Rotterdam", "country": "NL" },
    "entities": [{ "name": "Rotterdam", "kind": "port", "country": "NL", "lat": 51.95, "lon": 4.14 }],
    "match": {
      "id": "mat_mu48tqd1",
      "subscription_id": "sbn_mu48t9a2",
      "score": 0.87,
      "reviewed": true,
      "curator_note": "confirmed with the terminal",
      "explain": [{ "dimension": "geo", "score": 1, "weight": 0.25, "detail": "names a watched place: Rotterdam" }]
    }
  }],
  "count": 1,
  "next_cursor": "mat_mu48tqd1",
  "has_more": false
}
```

**Cursor rules.** Pass `next_cursor` back to get the next page. `null` means
you are up to date. The feed pages over *matches*, so one event that matches
three subscriptions arrives three times — once per subscription, each
separately acknowledgeable. **Deduplicate on `match.id`, not `event.id`.**

### `POST /v1/subscriptions`

```bash
curl -X POST http://127.0.0.1:4180/v1/subscriptions \
  -H "Authorization: Bearer pnd_YOUR_KEY" -H "Content-Type: application/json" \
  -d '{
    "name": "Rotterdam disruption",
    "filter": { "categories": ["port_disruption","labor_action"], "minSeverity": 3,
                "near": [{"lat":51.95,"lon":4.14,"radiusKm":600,"label":"Rotterdam"}] },
    "review_mode": "hybrid",
    "threshold": 0.45,
    "delivery": { "channels": [{ "type": "webhook", "url": "https://you.example/hook", "secret": "shared-secret" }] }
  }'
```

| Field | Default | Notes |
|---|---|---|
| `name` | *required* | |
| `filter` | `{}` | See above |
| `review_mode` | `"auto"` | `auto` \| `review` \| `hybrid` |
| `threshold` | `0.45` | Minimum score to count as relevant |
| `delivery.channels` | `[]` | Webhooks. Pull always works regardless |
| `backfill_hours` | `24` | Match against recent history on creation; `0` disables |

**Backfill.** A new subscription is matched against the last 24 hours of
stored events so your first poll is not empty. Without it a narrow filter can
look broken for days. Set `backfill_hours: 0` to opt out, or raise it to
seed a demo from older data.

### `POST /v1/subscriptions/:id/test` — dry run

Score a filter against stored history **without creating matches or sending
anything**. Tune a subscription against reality before switching it on.

```bash
curl -X POST http://127.0.0.1:4180/v1/subscriptions/sbn_123/test \
  -H "Authorization: Bearer pnd_YOUR_KEY" -H "Content-Type: application/json" \
  -d '{ "filter": { "categories": ["congestion"], "minSeverity": 4 }, "limit": 500 }'
```

```json
{
  "tested_against": 500,
  "would_match": 12,
  "match_rate": 0.024,
  "matches": [{ "event": {...}, "score": 0.81, "explain": [...] }],
  "rejected_sample": [{ "event": {...}, "score": 0, "explain": [{ "detail": "severity 2 below minimum 4" }] }]
}
```

`rejected_sample` is the useful half: it tells you *why* things you expected
did not match.

### `POST /v1/curation/matches/:id/approve`

```json
{ "title": "Rewritten headline", "summary": "…", "category": "port_disruption", "severity": 5, "note": "confirmed with the terminal" }
```

All fields optional; an empty body approves as-is. Edits apply to the
**delivered payload only** — the stored event is never modified.

### `POST /v1/curation/matches/:id/reject`

```json
{
  "reason": "cruise terminal, not freight",
  "rule": { "kind": "suppress", "target": "keyword", "value": "cruise", "weight": 0.3, "scope": "subscription" }
}
```

`rule` is optional. When present the rejection becomes permanent policy.
`kind`: `boost` | `suppress` | `block` | `require`.
`target`: `keyword` | `place` | `category` | `domain` | `country` | `source`.
`scope`: `subscription` (default) | `global`.

---

## Verifying a webhook

Pandora signs the string `<timestamp>.<raw body>` with HMAC-SHA256 and sends:

```
X-Pandora-Timestamp: 1789574400
X-Pandora-Signature: sha256=8f4e2a…
X-Pandora-Event-Id:  evt_mu48tqcz
```

Verify before trusting anything in the body. Use the **raw** body — parse the
JSON only after the signature checks out.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody, timestamp, signature, secret) {
  // Reject replays: the timestamp is inside the signed string, so an
  // attacker cannot reuse yesterday's valid delivery.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const expected = `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b); // constant time
}
```

Python:

```python
import hmac, hashlib, time

def verify(raw_body: bytes, timestamp: str, signature: str, secret: str) -> bool:
    if abs(time.time() - int(timestamp)) > 300:
        return False
    expected = "sha256=" + hmac.new(
        secret.encode(), f"{timestamp}.".encode() + raw_body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature)
```

**Respond `2xx` quickly.** Anything else is a failure and will be retried at
30s, 2m, 8m, 32m and 2h before being marked failed. Do your real work after
responding. Retries mean your handler must be idempotent — key on
`match.id`.

### The webhook body

```json
{
  "type": "event.delivered",
  "delivered_at": "2026-09-15T07:31:09Z",
  "subscription": { "id": "sbn_…", "name": "Rotterdam disruption" },
  "event": { "…the same shape as GET /v1/events…" }
}
```

---

## Rate limits and hardening

There are **none** yet — this is designed to run on your own machine or a
private network, and the server binds to `127.0.0.1` by default.

Before exposing it publicly you want, at minimum: rate limiting per key,
HTTPS termination, per-key request quotas, and a block on webhook URLs
pointing at private address ranges (an SSRF guard). None are difficult;
all are deliberate omissions rather than oversights.
