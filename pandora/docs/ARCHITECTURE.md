# How Pandora works, and why it works that way

Written for someone who wants to understand the system and make decisions
about it, not necessarily to write the code. Every section says what the
thing does, and then why it is built that way rather than some other way.

---

## 1. The problem, stated precisely

Useful information is published constantly — a port authority notice, a
weather warning, a seismograph reading, a wire story. Three things stop a
company from acting on it:

1. **It arrives in incompatible shapes.** A USGS earthquake is clean JSON with
   coordinates. A trade-press story is a sentence of prose. A weather alert is
   a map polygon. Nobody wants to write three integrations, so they write none.
2. **Almost all of it is irrelevant to any given company.** A forwarder with
   Rotterdam volumes does not care about a Chilean earthquake. Filtering by
   keyword is too crude; filtering by hand does not scale.
3. **The relevant part arrives too late to act on.** By the time it reaches an
   operations manager through a newsletter, the vessel has sailed.

Pandora is three answers, in order:

| Problem | Answer |
|---|---|
| Incompatible shapes | **Normalise** everything into one event schema |
| Too much noise | **Match** against explicit standing subscriptions, with a human on the doubtful cases |
| Too slow | **Deliver** to machines — webhook or pull — in seconds |

---

## 2. The pipeline

Five stages. Each one only talks to the next, so any stage can be replaced
without touching the others.

```
  ┌─────────┐   ┌───────────┐   ┌───────┐   ┌────────┐   ┌──────────┐
  │ INGEST  │──►│ NORMALISE │──►│ MATCH │──►│ ROUTE  │──►│ DELIVER  │
  └─────────┘   └───────────┘   └───────┘   └────────┘   └──────────┘
   poll feeds    one shape       score +     auto, or     webhook or
   dedupe        classify        explain     to a human   pull + retry
                 geo-locate                      │
                                                 ▼
                                            CURATION
                                         approve / edit /
                                         reject → RULE
                                                 │
                                                 └──► feeds back into MATCH
```

### Stage 1 — Ingest (`src/ingest/runner.js`)

Polls each source on its own interval. One **adapter** per kind of source
(`usgs`, `nws`, `gdelt`, `rss`), each ~40 lines, each ending at the same
`buildEvent()` call.

**Why adapters:** adding a source should be config, not a refactor. An RSS feed
needs zero code — just a row in the `sources` table with a URL.

**A failing source never stops the others.** Each poll is wrapped; an error is
recorded on the source row and the loop continues. A dead feed must not take
down your product.

**Two levels of deduplication**, because the same story arrives repeatedly:

| Level | Method | Catches |
|---|---|---|
| Exact | Hash of source id + external id, else URL (query string stripped), else title | The same item re-polled |
| Near | Same bucket (category + place + day) *and* ≥50% word overlap | Five outlets, one strike |

Near-duplicate detection compares *word sets*, not exact keys. An earlier
version used "the four longest words, alphabetically", which broke the moment
one outlet added an adjective. Overlap similarity is robust to how people
actually write headlines — and the corroboration count is kept, because five
outlets agreeing is itself a signal.

### Stage 2 — Normalise (`src/ingest/normalize.js`)

Turns anything into the canonical event. Three jobs:

**Classify** into one of 13 categories, by scoring weighted signal phrases.
`"berth closure"` is worth 3 toward `port_disruption`; a bare `"terminal"` is
worth 1. Highest total wins; the runners-up are recorded.

> **The bug that shaped this file.** The first version matched phrases with a
> plain substring test. The word `"reported"` contains `"port"`, so every wire
> story that said "Reported by Reuters" was classified as a port disruption.
> Everything now compiles to a **word-boundary regex** with explicit stems:
> `'clos*'` matches close/closed/closing/closure but `'port'` never matches
> "reported", "portfolio" or "transport". Multi-word phrases tolerate up to two
> filler words, so `'port clos*'` catches "the port has been closed".
>
> The lesson generalises: in text classification the failure mode is not
> usually a clever mistake, it is a stupid one that nobody looks for.

**Score severity** 1–5, with two corrections that matter operationally:

- *Category floors.* A drone attack on a vessel is at minimum severity 3 even
  if the wording is calm ("crew safe"). Careful reporting must not read as a
  non-event.
- *Recovery cap.* "Port reopened, normal operations resume" is capped at 3.
  A disruption **ending** should not page anyone at severity 5 — though it is
  still worth knowing.

**Geo-locate** by matching ~70 major ports and chokepoints in the text.

> **The second bug that shaped this file.** The anchor location was whichever
> gazetteer entry happened to be found first — which is dictionary order, not
> text order. A story headlined "Antwerp berth delays" that mentioned Rotterdam
> in the body was filed under Rotterdam. Places named in the **title** now win,
> then ports, then anything else.

This stage is where the leverage is. Everything downstream depends on the
category, severity and location being right, and every improvement here
improves every subscription at once.

### Stage 3 — Match (`src/match/engine.js`)

Two questions, in order.

**Hard gates — yes or no, no argument.** Things a subscriber is certain about:
an excluded keyword, a missing required keyword, an unwatched category, a
severity below their floor. Fail any and the event is simply not relevant.

**Then a weighted score, 0–1**, across five dimensions:

| Dimension | Weight | What it measures |
|---|---|---|
| Severity | 0.25 | How big a deal it is |
| Geography | 0.25 | How close to what they watch |
| Keywords | 0.20 | How many watched terms it mentions |
| Category | 0.15 | Whether the category is watched |
| Quality | 0.15 | Parse confidence × source trust |

**Only the dimensions a subscription actually expressed are counted, then the
weights are renormalised.** A subscription that says nothing about geography
is judged on the rest rather than penalised for silence. This is what lets a
filter be as simple as `{"minSeverity": 5}` and still score sensibly.

**Every score carries its reasoning.** This is a hard architectural rule, not
a nicety. A curator must judge an item in two seconds; a customer will ask
"why did you send me this?"; and when the matcher misbehaves you need to see
which dimension did it. A score you cannot interrogate is a score nobody will
trust, and trust is the product.

#### Geography deserves its own note

Matching is circle-to-circle, not point-in-circle: the event carries its own
radius (a hurricane covers a region, an earthquake shakes an area), so overlap
compares distance against the **sum** of both radii. A storm whose edge
reaches your port counts even if its centre does not.

> **The third bug that shaped this system.** Multiple geo constraints were
> OR'd together, so a subscription saying `countries: ["US"]` **and**
> `near: [Houston]` matched a Los Angeles storm — 2,000 km away — on the
> country alone. There is now an explicit `geoMatch: "any" | "all"`. The
> default is `"any"` (the usual intent: "anywhere on this list"), but when
> constraints are meant to narrow each other you say `"all"`.
>
> Both behaviours are defensible. Guessing between them silently is not.

An event with **no** known location scores 0.35 rather than being rejected —
uncertain, not irrelevant — so a human sees it rather than it vanishing.

### Stage 4 — Route (`src/match/matcher.js`)

Decides whether a match ships now or waits for a person. This is the
human-in-the-loop design, and the reasoning behind it is the most important
product decision in the system.

The naive version is "low scores go to a human". That is wrong: low scores are
already dropped below the threshold. **What a human should see is what the
machine is unsure about.** In `hybrid` mode an item waits when:

- parse confidence is below 0.6 — often a bare headline with no body text
- source trust is below 0.7 — a wide-net feed like GDELT, not the USGS
- the score is within 0.15 of the threshold — a coin flip either way

Everything else ships unattended. On the sample data that is **2 items out of
21** — roughly ten minutes a day. Get this wrong and the queue fills up, the
curator stops opening it, and you have shipped an unfiltered feed with extra
steps.

### Stage 5 — Deliver (`src/delivery/`)

Two channels, and the difference is more consequential than it looks.

**Pull** — the agent polls `/v1/events` with a cursor. Works behind any
firewall, needs no inbound network exposure, and the agent controls its own
rate. Most AI agents want this, and every approved match always gets a pull
record even when a webhook exists, so nothing is ever lost to a failed push.

**Webhook** — Pandora POSTs to the customer. Lower latency, but they must run
a server that stays up. Signed with HMAC-SHA256 over `timestamp.body`, the
same scheme Stripe and GitHub use — receiving engineers already know it, and
putting the timestamp inside the signed string blocks replay. Failures retry
five times with exponential backoff **and jitter**; the jitter stops a whole
batch retrying in lockstep and knocking over a customer's server the moment it
recovers.

Every attempt is logged with its status code and error. Without that log you
cannot answer "did my customer actually get the alert?", which is the only
question anyone asks when something has gone wrong.

---

## 3. The feedback loop

This is what makes the product defensible. Anyone can forward RSS; a system
that gets more accurate for a customer the longer they use it is much harder
to copy, because the advantage lives in accumulated data rather than code.

```
  curator rejects an item
        │
        ├──► recorded in `feedback` (kept forever)
        │
        └──► optionally becomes a RULE
                 │
                 ▼
        boost / suppress / block / require
                 │
                 ▼
        applied to every future match  ──► fewer items reach the queue
                 │                              │
                 └──────────────────────────────┘
```

Rules are deliberately **simple and inspectable** — a kind, a target, a value,
a weight — rather than a learned model. A curator can read the rule list and
predict the system's behaviour, which matters enormously when you are asking
someone to trust it. The `hits` counter shows which rules earn their keep.

The `feedback` table is the long game. Every human judgement, kept forever,
with the event and the score that prompted it. That is a labelled training set
for whatever replaces the keyword classifier later, and it is worth more than
this repository.

---

## 4. Technology choices

| Choice | Why | When it stops being right |
|---|---|---|
| **Node, zero dependencies** | Nothing to audit, patch or break. `npm install` does nothing. It will still run in five years | When you need something genuinely hard — a real NLP model, a job queue |
| **SQLite (`node:sqlite`)** | The whole database is one file. No server, no connection strings, trivially backed up by copying it | The day you need two machines writing. Then Postgres — the SQL barely changes |
| **Keyword classification** | Free, instant, debuggable, and a curator can read why it decided something | When accuracy plateaus. Then send only the *uncertain* items to an LLM — one step between normalise and match |
| **Fixtures for offline dev** | The pipeline runs identically with no internet, no keys, no rate limits. Tests are fast and deterministic | Never. Keep this |
| **Hand-written HTTP router** | ~70 lines against a framework and its dependency tree | When you need middleware, sessions, file uploads |
| **No build step on the front end** | Edit a file, refresh the browser | When the console outgrows one file |

The theme: **choose the boring thing that can be understood in an afternoon,
and leave an obvious exit.** Every one of these has a known upgrade path, and
none of them has to be decided before there are customers.

---

## 5. The data model

Nine tables. Reading `src/schema.sql` top to bottom is the fastest way to
understand the product.

```
sources ──┐
          ├──► events ──┐
          │             ├──► matches ──┬──► deliveries
subscribers ──► subscriptions ─────────┤
          │                            └──► feedback ──► rules
          └──────────────────────────────────────────────┘
                        (rules feed back into matching)
```

| Table | Holds | The thing to understand |
|---|---|---|
| `sources` | Where signals come from | `trust` drives both scoring and curation routing |
| `events` | Normalised events | `raw` keeps the original payload forever — you can always re-parse |
| `subscribers` | Users and agents | Only a **hash** of each API key; a database leak is not a credential leak |
| `subscriptions` | Standing requests | `filter` is JSON, so subscribers can be expressive without a query language |
| `matches` | Event × subscription | `explain` is the full reasoning; `override` holds curator edits |
| `rules` | Human corrections | `hits` shows which rules actually fire |
| `feedback` | Every judgement | Never deleted. This is the asset |
| `deliveries` | Proof of handover | Full retry history per attempt |
| `event_clusters` | Near-duplicate groups | `seen_count` = how many outlets corroborated |

**One deliberate decision worth calling out:** a curator's edits go in
`matches.override`, never into `events`. The customer receives the edited
version; the stored event keeps what the source actually said. You can always
reconstruct both, and you never lose the original — which matters the first
time someone disputes what you sent them.

---

## 6. Where this breaks, honestly

| Limit | Reality | When it bites |
|---|---|---|
| **Single process** | API and worker in one Node process | Thousands of subscriptions, or a slow source blocking a poll cycle |
| **SQLite writes** | One writer at a time | Sustained high-frequency ingest across many sources |
| **~70 places** | Geographic matching is only as good as the gazetteer | Immediately, for any customer outside the major container trades |
| **English only** | Signal phrases are English | Any non-English source. GDELT indexes 65 languages you cannot currently classify |
| **No rate limiting** | Any valid key can hammer the API | The moment it is exposed publicly |
| **Webhook SSRF** | Webhook URLs are not checked against private ranges | The moment untrusted users can create subscriptions |
| **Keyword ceiling** | Rules and keywords plateau around "good enough" | When a customer's precision demands exceed what phrases can express |

The first two are hours of work when they matter. The gazetteer is the one to
attack first — it is pure data entry and it improves every subscription at
once. The last one is where an LLM pass earns its cost, and the architecture
already has the slot for it.

---

## 7. If you are taking this to market

The technical build is the easy half. In rough order of what I would do next:

1. **Pick one vertical and one geography.** "Port disruption for European
   freight forwarders" beats "global event intelligence". The gazetteer, the
   taxonomy and the source list all get better when they are narrow.
2. **Add email delivery.** The fastest way to demo this to a non-technical
   buyer, and a small job. An operations manager forwarding your alert to a
   colleague is your best marketing.
3. **Run the curation queue yourself for the first ten customers.** It is the
   cheapest market research available: you will learn what actually matters
   faster than any interview, and every decision improves the product.
4. **Sell the explanation, not the alert.** Competitors sell feeds. "Here is
   why we sent you this, and here is the switch to change it" is the
   differentiator — and you already have it.
5. **Measure one number: approval rate.** If curators approve most of what
   they see, the filters are right. If they reject most of it, you are wasting
   the customer's time and they will churn. It is on the dashboard for a reason.
