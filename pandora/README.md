# Pandora — event subscriptions for AI agents

**The internet is constantly publishing things your systems should react to.
Pandora turns that stream into structured events, decides which ones matter to
whom, lets a human check the doubtful ones, and delivers the rest to machines.**

A logistics company subscribes to *"port disruptions within 600 km of
Rotterdam, severity 3 and above"*. Two hours later a dockworkers' strike is
announced. Pandora reads it, works out it is a `labor_action` at severity 4
located at Rotterdam, matches it to that subscription, and POSTs a signed JSON
payload to their system — which reroutes three vessels before anyone has
opened a newspaper.

```bash
npm run setup   # create the database, print your API keys
npm run demo    # run the whole pipeline once and watch what it does
npm run dev     # open the console at http://127.0.0.1:4180
```

No API keys to buy. No accounts to create. No dependencies to install — it
runs on Node alone. Out of the box it replays recorded sample data so you can
see the whole thing work offline; flip one setting to go live.

---

## Contents

- [The idea in one picture](#the-idea-in-one-picture)
- [The five concepts](#the-five-concepts)
- [Getting it running](#getting-it-running)
- [The curator's job](#the-curators-job)
- [How an AI agent uses it](#how-an-ai-agent-uses-it)
- [Going live on real feeds](#going-live-on-real-feeds)
- [Adding your own source](#adding-your-own-source)
- [What it costs to run](#what-it-costs-to-run)
- [What is deliberately not built yet](#what-is-deliberately-not-built-yet)

---

## The idea in one picture

```
   PUBLIC INTERNET                    PANDORA                      CUSTOMERS
   ───────────────                    ───────                      ─────────

   USGS earthquakes  ┐
   Weather alerts    ├─► INGEST ─► NORMALISE ─► MATCH ─┬─► confident ──────┐
   News wires (RSS)  │    poll      one shape   score  │                   │
   GDELT world news  ┘    feeds     for all     +why   └─► unsure ─► HUMAN ─┤
                                                             REVIEW        │
                                                          approve/edit/    │
                                                            reject         │
                                                               │           ▼
                                                               │      DELIVER
                                                               │    ├ webhook (push)
                                                          becomes a  └ API (pull)
                                                          RULE that       │
                                                          improves        ▼
                                                          matching    AI AGENTS
                                                               ▲      & systems
                                                               └──────────┘
                                                             feedback loop
```

The loop at the bottom is the part that matters commercially. Anyone can
forward RSS. What makes this defensible is that **every human judgement makes
the next match better**, so the product gets more accurate for a customer the
longer they use it — and that is very hard for a competitor to copy, because
it lives in your data, not your code.

---

## The five concepts

Learn these five words and you understand the entire system.

### 1. Source
A place on the internet we poll. Four are set up for you:

| Source | What it gives you | Cost | Notes |
|---|---|---|---|
| **USGS** | Earthquakes worldwide, M4.5+ | free, no key | Precise, structured, trustworthy |
| **NWS** | US weather alerts | free, no key | Hurricanes, gales, fog — with map polygons |
| **GDELT** | World news in 65 languages | free, no key | Enormous reach, very noisy |
| **RSS** | Any feed you point it at | free | Trade press, port authorities, customs |

Each source has a **trust** score from 0 to 1. USGS is 0.98 — when it says
there was an earthquake, there was an earthquake. GDELT is 0.55 — it finds
everything, including a lot that does not matter. Trust feeds directly into
scoring and into whether a human sees something before it ships.

### 2. Event
A single thing that happened, flattened into one shape no matter which source
it came from. That uniformity *is* the product: your agent writes code once.

```json
{
  "id": "evt_mu48tqcz9f2a1b",
  "title": "Dockworkers begin 48-hour walkout at Port of Rotterdam",
  "category": "labor_action",
  "severity": 4,
  "confidence": 0.86,
  "occurred_at": "2026-09-15T07:15:00Z",
  "location": { "lat": 51.95, "lon": 4.14, "radius_km": 50, "place": "Rotterdam", "country": "NL" },
  "entities": [{ "name": "Rotterdam", "kind": "port", "country": "NL" }],
  "url": "https://..."
}
```

Thirteen categories (`port_disruption`, `congestion`, `labor_action`,
`weather`, `earthquake`, `flood`, `wildfire`, `security`, `regulatory`,
`infrastructure`, `cyber`, `health`, `other`) and five severities
(1 info → 5 critical).

The clever bit: a news headline arrives as plain text with **no coordinates**.
Pandora recognises around 70 major ports and chokepoints by name, so
*"strike at Rotterdam"* becomes a point on the map — which is what makes
*"anything within 600 km of my hub"* possible at all.

### 3. Subscription
A standing request: *tell me about this*. Expressed as a filter:

```json
{
  "name": "North-west Europe port disruption",
  "filter": {
    "categories": ["port_disruption", "labor_action", "congestion"],
    "minSeverity": 3,
    "near": [{ "lat": 51.95, "lon": 4.14, "radiusKm": 600, "label": "Rotterdam hub" }],
    "keywordsNone": ["opinion", "interview"]
  },
  "review_mode": "hybrid",
  "delivery": { "channels": [{ "type": "webhook", "url": "https://you.example/hook" }] }
}
```

`review_mode` is the human-in-the-loop dial, and it is the most important
setting in the product:

| Mode | Behaviour | Use it when |
|---|---|---|
| `auto` | Everything relevant ships immediately | The source is authoritative — earthquakes, official weather alerts |
| `review` | Everything waits for a human | High-stakes customers, or a brand-new filter you do not trust yet |
| `hybrid` | Confident matches ship; doubtful ones wait | **Almost always.** This is the mode the product is designed around |

### 4. Match
"This event looks relevant to this subscription, and here is the score."

The score is a weighted average of the dimensions the subscription actually
expressed — severity, geography, keywords, category, source quality.
Dimensions you did not ask about are not counted against you.

**Every score comes with its reasoning**, and this is non-negotiable in the
design. A curator has to judge an item in two seconds, and a customer will
eventually ask "why did you send me this?":

| dimension | score | reason |
|---|---|---|
| gate | ✓ | severity 4 ≥ minimum 3 |
| severity | 0.75 | severity 4/5 |
| quality | 0.74 | parse confidence 0.86, source trust 0.55 |
| geo | 1.00 | names a watched place: Rotterdam |
| category | 1.00 | category "labor_action" is watched |
| **total** | **0.87** | above this subscription's threshold of 0.45 |
| routing | ✓ | source trust 0.55 is low — wide-net feed, curate before sending |

### 5. Rule
How a human permanently teaches the matcher.

| Kind | Effect | Example |
|---|---|---|
| `boost` | Raises the score | "anything saying *berth closure* matters more to us" |
| `suppress` | Lowers the score | "this outlet over-reports" |
| `block` | Vetoes outright | "never send me anything from this domain" |
| `require` | Demands a signal | "only send me items mentioning *container*" |

Reject something in the console with **Reject + rule** and the rule is written
for you. That afternoon of clicking becomes an evening of less clicking.

---

## Getting it running

You need [Node.js](https://nodejs.org) 22.5 or newer. Check with `node -v`.

```bash
cd pandora
cp .env.example .env     # optional — every setting has a working default
npm run setup
```

`setup` prints two API keys. **Copy them now** — only a cryptographic hash of
each is stored, so they cannot be shown again. (If you lose one, delete the
subscriber and mint a new key; that is a feature, not a limitation.)

```
┌─ API KEYS — copy these now ─────────────────────────────┐
│  curator (admin)    pnd_XcQ2…    ← you, in the console
│  agent              pnd_8fRk…    ← your AI system
└─────────────────────────────────────────────────────────┘
```

Then:

```bash
npm run demo     # see the whole pipeline work in your terminal
npm run dev      # start the console at http://127.0.0.1:4180
npm test         # 71 tests
```

Paste the **curator** key into the console. That is the whole setup.

---

## The curator's job

This is the part most competitors get wrong. The queue must stay small enough
that a person will actually work it, or it gets ignored and the product is
just an unfiltered feed with extra steps.

So Pandora does **not** send a human everything. In `hybrid` mode an item goes
to review only when the machine is genuinely unsure:

- the parse was a guess (low confidence — often a bare headline with no body)
- the source is a wide net (low trust — GDELT rather than the USGS)
- the score sits within 0.15 of the threshold (a coin flip either way)

Everything else ships on its own. In the sample data that is **2 items for
review out of 21 events** — about ten minutes of work a day, not a full-time job.

For each item a curator can:

- **Approve & send** — it was right
- **Edit first** — rewrite the headline, correct the category or severity, add
  a note, then send. *Your edits change what the customer receives; the stored
  event is never altered, so the original source of truth survives.*
- **Reject** — not relevant
- **Reject + rule** — not relevant, and never send anything like it again

Every decision is stored in the `feedback` table forever. That table is your
training data if you later want to replace the keyword classifier with a
model — and it is worth more than the code.

---

## How an AI agent uses it

Two ways in, and the choice is more consequential than it looks.

### Pull (recommended for agents)

The agent polls on its own schedule and keeps a cursor. Nothing is ever missed
or processed twice, and it works from behind any firewall with no inbound
network exposure. Most AI agents want this.

```bash
curl -H "Authorization: Bearer pnd_YOUR_AGENT_KEY" \
  "http://127.0.0.1:4180/v1/events?limit=50"
```

```json
{
  "events": [ { "id": "evt_…", "title": "…", "severity": 4, "match": { "score": 0.87, "explain": [...] } } ],
  "next_cursor": "mat_mu48tqd1",
  "has_more": false
}
```

Store `next_cursor`, pass it back next time, and you resume exactly where you
stopped. A complete working agent is in [`examples/agent.mjs`](examples/agent.mjs).

### Push (webhook)

Pandora POSTs to your URL the moment something matches. Lower latency, but you
have to run a server that stays up.

Every delivery is signed the way Stripe and GitHub sign theirs, so your
receiver can prove it came from Pandora and was not tampered with or replayed:

```
X-Pandora-Timestamp: 1789574400
X-Pandora-Signature: sha256=8f4e2a…
```

Verifying takes five lines — see [`docs/API.md`](docs/API.md#verifying-a-webhook).
Failed deliveries retry five times with exponential backoff (30s, 2m, 8m, 32m,
2h) and are recorded either way, so you can always answer *"did the customer
actually get it?"*.

**Full API reference: [`docs/API.md`](docs/API.md).**

---

## Going live on real feeds

The default is `INGEST_MODE=fixture`, which replays recorded samples from
`./fixtures`. Everything downstream of fetching is identical, so what you see
offline is what you get online. To use the real internet:

```bash
# in .env
INGEST_MODE=live
INGEST_CONTACT=you@yourcompany.com   # several government feeds ask for this
```

Then `npm run dev`. USGS, NWS and GDELT need no keys. For RSS, edit the source
in the console or via the API and point it at a real feed URL.

> **A note on scraping.** Public APIs and RSS feeds are published to be read,
> and this polls them at a polite interval with an identifying User-Agent.
> Some publishers still restrict reuse in their terms — check before you build
> a commercial product on any single feed, and prefer official APIs and
> government sources, which is what the defaults are.

---

## Adding your own source

The long tail of coverage is where the value is, and most of it is free.
Port authorities, customs agencies and trade press nearly all publish RSS.
Adding one needs **no code**:

```bash
curl -X POST http://127.0.0.1:4180/v1/sources \
  -H "Authorization: Bearer pnd_YOUR_CURATOR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Port of Rotterdam — notices",
    "adapter": "rss",
    "trust": 0.9,
    "poll_seconds": 600,
    "config": {
      "url": "https://www.portofrotterdam.com/en/news.rss",
      "keywordsAny": ["closure", "strike", "delay", "restriction"]
    }
  }'
```

A genuinely new *kind* of source (a JSON API with its own shape) needs about
40 lines: drop a file in `src/ingest/adapters/`, register it in
`src/ingest/registry.js`. Copy `usgs.js` — it is the clearest example.

---

## What it costs to run

Effectively nothing to start, which is the point.

| | Cost |
|---|---|
| Data sources | **$0** — every default source is free and key-less |
| Database | **$0** — SQLite, one file on disk |
| Dependencies | **$0** — there are none; it is plain Node |
| Hosting | **$0** on your laptop; ~$5/month on the smallest VPS |
| Your time | ~10 minutes a day working the review queue |

One machine will handle tens of thousands of events and hundreds of
subscriptions comfortably. You do not need to think about scale until you have
paying customers, and by then the answer (move SQLite to Postgres, split the
worker from the API) is a known, boring problem.

---

## What is deliberately not built yet

Being straight about the gaps is more useful than a longer feature list.
Roughly in the order I would build them:

1. **Email and Slack delivery.** Webhook and pull only today. Email is the
   fastest way to demo this to a non-technical buyer, and it is a small job.
2. **An LLM classification pass.** The classifier is keyword-and-rules — fast,
   free, debuggable, and it plateaus. Sending only the *uncertain* items to a
   model would lift accuracy a lot for very little cost. The architecture is
   already shaped for this: it is one more step between normalise and match.
3. **A bigger gazetteer.** ~70 places today. Geographic matching is only as
   good as this list, and expanding it is the cheapest accuracy win available.
4. **Rules learned automatically.** Rules are written by hand or from a
   rejection. The `feedback` table has everything needed to *suggest* them
   ("you have rejected 7 items mentioning 'cruise' — suppress it?").
5. **Multi-tenancy proper.** Subscribers are isolated, but there is no billing,
   no per-customer rate limiting, and no organisation layer above a subscriber.
6. **Postgres.** SQLite is genuinely right for one machine and will stop being
   right the day you need two.

Not vapour, just not built. Each one is a normal week or two of work, and
none of them require unpicking what is already here.

---

## Where things live

```
pandora/
├── src/
│   ├── schema.sql          ← read this first; it IS the data model
│   ├── ingest/             ← fetching, classifying, de-duplicating
│   │   ├── adapters/       ← one file per kind of source
│   │   ├── taxonomy.js     ← the categories and severity vocabulary
│   │   ├── gazetteer.js    ← place names → coordinates
│   │   └── normalize.js    ← anything → one canonical event
│   ├── match/              ← scoring, explanations, curation rules
│   ├── delivery/           ← signed webhooks, retries, the pull queue
│   ├── api/                ← the HTTP API agents talk to
│   └── web/                ← the curator console (no build step)
├── fixtures/               ← recorded samples, so it runs offline
├── examples/agent.mjs      ← a complete consuming agent
├── docs/ARCHITECTURE.md    ← how and why it works this way
├── docs/API.md             ← full endpoint reference
└── test/                   ← 71 tests
```

MIT licensed. Built as a standalone application inside the Pandora repository;
it shares no code with the 3D globe at the repository root.
