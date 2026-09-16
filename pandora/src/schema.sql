-- ============================================================================
-- Pandora Events — database schema
--
-- Read this top to bottom and you understand the whole product:
--   sources  → where signals come from
--   events   → one normalised thing that happened in the world
--   subscribers / subscriptions → who wants what
--   matches  → "this event looks relevant to this subscription"
--   rules    → human corrections that make future matching smarter
--   deliveries → proof we actually handed it over
-- ============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── SOURCES ────────────────────────────────────────────────────────────────
-- A place on the public internet we poll. One row per feed.
CREATE TABLE IF NOT EXISTS sources (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  adapter         TEXT NOT NULL,            -- usgs | nws | gdelt | rss
  config          TEXT NOT NULL DEFAULT '{}', -- JSON: url, query, defaults
  enabled         INTEGER NOT NULL DEFAULT 1,
  trust           REAL NOT NULL DEFAULT 0.8,  -- 0..1, feeds into match score
  poll_seconds    INTEGER NOT NULL DEFAULT 300,
  last_polled_at  TEXT,
  last_status     TEXT,                     -- ok | error
  last_error      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── EVENTS ─────────────────────────────────────────────────────────────────
-- The canonical record. Every source, however messy, is flattened into this
-- shape. Agents only ever see this shape — that is the whole point.
CREATE TABLE IF NOT EXISTS events (
  id            TEXT PRIMARY KEY,
  source_id     TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  external_id   TEXT,                       -- the id the source gave it
  dedupe_hash   TEXT NOT NULL UNIQUE,       -- stops the same story landing twice

  title         TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  url           TEXT,

  category      TEXT NOT NULL DEFAULT 'other',
  severity      INTEGER NOT NULL DEFAULT 2, -- 1 info … 5 critical
  confidence    REAL NOT NULL DEFAULT 0.5,  -- how sure we are of the parse

  occurred_at   TEXT NOT NULL,
  ingested_at   TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT,

  lat           REAL,
  lon           REAL,
  radius_km     REAL,                       -- area of effect, not precision
  place_name    TEXT,
  country       TEXT,

  entities      TEXT NOT NULL DEFAULT '[]', -- JSON: ports, chokepoints, orgs
  raw           TEXT NOT NULL DEFAULT '{}', -- the untouched original payload

  cluster_key   TEXT,                       -- coarse bucket: category|place|day
  title_tokens  TEXT NOT NULL DEFAULT '[]'  -- stemmed words, for near-dup scoring
);
CREATE INDEX IF NOT EXISTS idx_events_occurred  ON events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_category  ON events(category);
CREATE INDEX IF NOT EXISTS idx_events_ingested  ON events(ingested_at DESC);

-- ── SUBSCRIBERS ────────────────────────────────────────────────────────────
-- A customer: a human team, or an AI agent holding an API key.
CREATE TABLE IF NOT EXISTS subscribers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'agent',  -- agent | human
  api_key_hash TEXT NOT NULL UNIQUE,           -- we never store the key itself
  api_key_hint TEXT NOT NULL,                  -- last 4 chars, for the UI
  is_admin     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── SUBSCRIPTIONS ──────────────────────────────────────────────────────────
-- A standing request: "tell me about X". The filter is JSON so a subscriber
-- can express something rich without us inventing a query language.
CREATE TABLE IF NOT EXISTS subscriptions (
  id            TEXT PRIMARY KEY,
  subscriber_id TEXT NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  filter        TEXT NOT NULL DEFAULT '{}',  -- JSON, see docs/API.md
  delivery      TEXT NOT NULL DEFAULT '{}',  -- JSON: {channels:[...]}
  review_mode   TEXT NOT NULL DEFAULT 'auto', -- auto | review | hybrid
  threshold     REAL NOT NULL DEFAULT 0.45,   -- min score to be relevant
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_subs_active ON subscriptions(active);

-- ── MATCHES ────────────────────────────────────────────────────────────────
-- The heart of it. One row = "event E may be relevant to subscription S".
-- `explain` is a human-readable trace of WHY, so a curator can judge it in
-- two seconds instead of guessing.
CREATE TABLE IF NOT EXISTS matches (
  id              TEXT PRIMARY KEY,
  event_id        TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  score           REAL NOT NULL,
  base_score      REAL NOT NULL,            -- score before curation rules
  explain         TEXT NOT NULL DEFAULT '[]', -- JSON array of reasons
  status          TEXT NOT NULL,            -- pending | approved | rejected
                                            -- | delivered | failed | suppressed
  decided_by      TEXT,                     -- 'auto' | 'rule:<id>' | subscriber id
  decided_at      TEXT,
  override        TEXT,                     -- JSON: curator's edits to the payload
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(event_id, subscription_id)
);
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_matches_sub    ON matches(subscription_id, created_at DESC);

-- ── CURATION RULES ─────────────────────────────────────────────────────────
-- How a human teaches the matcher. Each rule nudges the score up or down, or
-- hard-blocks. Created by hand, or generated when a curator rejects something
-- and says "always do this".
CREATE TABLE IF NOT EXISTS rules (
  id              TEXT PRIMARY KEY,
  subscription_id TEXT REFERENCES subscriptions(id) ON DELETE CASCADE, -- NULL = global
  kind            TEXT NOT NULL,      -- boost | suppress | block | require
  target          TEXT NOT NULL,      -- keyword | source | category | domain
  value           TEXT NOT NULL,
  weight          REAL NOT NULL DEFAULT 0.2,
  note            TEXT,
  created_by      TEXT,
  active          INTEGER NOT NULL DEFAULT 1,
  hits            INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rules_sub ON rules(subscription_id, active);

-- ── FEEDBACK ───────────────────────────────────────────────────────────────
-- Every human or agent judgement, kept forever. This is the training data
-- that makes the product better than a keyword alert over time.
CREATE TABLE IF NOT EXISTS feedback (
  id         TEXT PRIMARY KEY,
  match_id   TEXT REFERENCES matches(id) ON DELETE SET NULL,
  event_id   TEXT REFERENCES events(id) ON DELETE CASCADE,
  actor      TEXT NOT NULL,          -- subscriber id or 'curator'
  verdict    TEXT NOT NULL,          -- useful | not_useful | wrong_category
                                     -- | wrong_severity | duplicate
  reason     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── DELIVERIES ─────────────────────────────────────────────────────────────
-- Proof of handover, with the full retry history. Without this you cannot
-- answer "did my customer actually get the alert?" — which is the only
-- question that matters when something goes wrong.
CREATE TABLE IF NOT EXISTS deliveries (
  id           TEXT PRIMARY KEY,
  match_id     TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  channel      TEXT NOT NULL,        -- webhook | pull
  endpoint     TEXT,
  status       TEXT NOT NULL,        -- pending | succeeded | failed
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_code    INTEGER,
  last_error   TEXT,
  next_retry_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_deliveries_pending ON deliveries(status, next_retry_at);

-- ── DEDUPE LEDGER ──────────────────────────────────────────────────────────
-- Near-duplicate suppression across sources: five outlets reporting the same
-- strike should reach an agent once, not five times.
--
-- `cluster_key` is only a coarse bucket (category | place | day). Within a
-- bucket we compare the events' word signatures, because headlines about one
-- event are never worded identically — they overlap. An exact key made of
-- "the first four words alphabetically" breaks the moment one outlet adds an
-- adjective, which is to say immediately.
CREATE TABLE IF NOT EXISTS event_clusters (
  id           TEXT PRIMARY KEY,
  cluster_key  TEXT NOT NULL,
  event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  seen_count   INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_clusters_key ON event_clusters(cluster_key, last_seen_at DESC);
