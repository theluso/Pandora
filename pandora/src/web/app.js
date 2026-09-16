/**
 * Pandora console — a single-file, no-build, no-framework front end.
 *
 * It is a thin client over the same public API an agent uses. Nothing here is
 * privileged: every action is an HTTP call you could make with curl, which is
 * deliberate — the dashboard must never become the only way to do something.
 */

const SEVERITY = { 1: 'info', 2: 'minor', 3: 'moderate', 4: 'major', 5: 'critical' };

const state = {
  key: localStorage.getItem('pandora.key') ?? '',
  tab: 'queue',
  subscriptions: [],
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

/** Escape anything that came from the internet before it touches innerHTML. */
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${state.key}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

let toastTimer;
function toast(message, kind = '') {
  const element = $('#toast');
  element.textContent = message;
  element.className = `toast ${kind}`;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.hidden = true; }, 3800);
}

function timeAgo(iso) {
  if (!iso) return '';
  const seconds = (Date.now() - new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') || iso.includes('+') ? '' : 'Z'))) / 1000;
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 90) return 'just now';
  const units = [[60, 'min'], [24, 'h'], [365, 'd']];
  let value = seconds / 60;
  let unit = 'min';
  for (const [divisor, label] of units) {
    if (value < divisor) { unit = label; break; }
    value /= divisor;
    unit = label === 'min' ? 'h' : label === 'h' ? 'd' : 'y';
  }
  return `${Math.round(value)}${unit} ago`;
}

/** Render the matcher's reasoning as a readable table. This is the feature. */
function explainTable(explain = []) {
  if (!explain.length) return '';
  const rows = explain.map((entry) => {
    const failed = entry.passed === false;
    const number = entry.score !== undefined ? entry.score.toFixed(2)
      : entry.delta !== undefined ? (entry.delta > 0 ? `+${entry.delta}` : String(entry.delta))
      : failed ? '✕' : '✓';
    return `<div class="why-row ${failed ? 'fail' : ''} ${entry.dimension === 'total' ? 'total' : ''}">
        <b>${esc(entry.dimension)}</b><span class="n">${esc(number)}</span><span>${esc(entry.detail)}</span>
      </div>`;
  }).join('');
  return `<details class="why"><summary>Why this scored what it did</summary>
      <div class="why-table">${rows}</div></details>`;
}

function eventTags(event) {
  const bits = [
    `<span class="tag">${esc(event.category)}</span>`,
    `<span class="tag sev-${event.severity}">${event.severity} · ${SEVERITY[event.severity] ?? '?'}</span>`,
  ];
  if (event.location?.place) bits.push(`<span>📍 ${esc(event.location.place)}</span>`);
  if (event.occurred_at) bits.push(`<span>${timeAgo(event.occurred_at)}</span>`);
  return bits.join('');
}

// ── Review queue ────────────────────────────────────────────────────────────
async function renderQueue() {
  const { items, pending } = await api('/v1/curation/queue?limit=100');
  $('#queue-count').textContent = pending;
  $('#queue-count').dataset.zero = pending === 0;

  if (!items.length) {
    $('#queue-list').innerHTML = `<div class="empty"><b>Queue is clear</b>
      Nothing is waiting on a human. Matches only land here when the system is unsure —
      a low-trust source, a shaky parse, or a score close to the line.</div>`;
    return;
  }

  $('#queue-list').innerHTML = items.map((item) => {
    const event = item.event;
    return `<article class="card" data-match="${esc(item.match_id)}">
      <div class="card-top">
        <div style="flex:1">
          <h3>${event.url ? `<a href="${esc(event.url)}" target="_blank" rel="noopener">${esc(event.title)}</a>` : esc(event.title)}</h3>
          ${event.summary ? `<p class="muted" style="margin:6px 0 0;font-size:13px">${esc(event.summary.slice(0, 260))}</p>` : ''}
          <div class="meta">
            ${eventTags(event)}
            <span>→ ${esc(item.subscription.name)}</span>
            ${item.source ? `<span class="tag">${esc(item.source.name)} · trust ${item.source.trust}</span>` : ''}
          </div>
        </div>
        <div class="score">${item.score.toFixed(2)}<small>SCORE</small></div>
      </div>
      ${explainTable(item.explain)}
      <div class="row-actions">
        <button class="ok" data-act="approve">Approve &amp; send</button>
        <button data-act="toggle-edit">Edit first</button>
        <button class="bad" data-act="reject">Reject</button>
        <button class="bad" data-act="reject-rule" title="Reject and never send anything like it again">Reject + rule</button>
      </div>
      <div class="edit-box">
        <input class="full" data-field="title" value="${esc(event.title)}" placeholder="Headline as the customer will see it">
        <select data-field="severity">
          ${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${n === event.severity ? 'selected' : ''}>severity ${n} · ${SEVERITY[n]}</option>`).join('')}
        </select>
        <input data-field="note" placeholder="Curator note (optional)">
        <button class="ok full" data-act="approve-edited">Send with these edits</button>
      </div>
    </article>`;
  }).join('');
}

async function handleQueueAction(card, action) {
  const matchId = card.dataset.match;
  const field = (name) => card.querySelector(`[data-field="${name}"]`);

  if (action === 'toggle-edit') {
    card.querySelector('.edit-box').classList.toggle('open');
    return;
  }

  if (action === 'approve') {
    await api(`/v1/curation/matches/${matchId}/approve`, { method: 'POST', body: {} });
    toast('Approved and queued for delivery', 'ok');
  }

  if (action === 'approve-edited') {
    await api(`/v1/curation/matches/${matchId}/approve`, {
      method: 'POST',
      body: {
        title: field('title').value.trim() || undefined,
        severity: Number(field('severity').value),
        note: field('note').value.trim() || undefined,
      },
    });
    toast('Approved with your edits', 'ok');
  }

  if (action === 'reject') {
    await api(`/v1/curation/matches/${matchId}/reject`, {
      method: 'POST', body: { reason: 'Not relevant' },
    });
    toast('Rejected');
  }

  if (action === 'reject-rule') {
    const value = prompt(
      'Reject this, and suppress anything mentioning…\n\n' +
      'Enter a keyword (e.g. "aftershock"). Every future match containing it\n' +
      'will score lower for this subscription.',
    );
    if (!value) return;
    const { rule } = await api(`/v1/curation/matches/${matchId}/reject`, {
      method: 'POST',
      body: {
        reason: `Curator suppressed "${value}"`,
        rule: { kind: 'suppress', target: 'keyword', value, weight: 0.3, scope: 'subscription' },
      },
    });
    toast(rule ? `Rejected — rule created for "${value}"` : 'Rejected', 'ok');
  }

  await Promise.all([renderQueue(), renderStats()]);
}

// ── Events ──────────────────────────────────────────────────────────────────
async function renderEvents() {
  const { events } = await api('/v1/events?limit=100&mine=false');
  $('#events-list').innerHTML = events.length
    ? events.reverse().map((event) => `<article class="card">
        <div class="card-top">
          <div style="flex:1">
            <h3>${event.url ? `<a href="${esc(event.url)}" target="_blank" rel="noopener">${esc(event.title)}</a>` : esc(event.title)}</h3>
            <div class="meta">${eventTags(event)}
              ${event.match?.reviewed ? '<span class="tag status-ok">human reviewed</span>' : ''}
              ${event.entities?.length ? `<span>${esc(event.entities.map((e) => e.name).join(', '))}</span>` : ''}
            </div>
          </div>
          <div class="score">${event.match ? event.match.score.toFixed(2) : '—'}<small>SCORE</small></div>
        </div>
        ${explainTable(event.match?.explain)}
      </article>`).join('')
    : `<div class="empty"><b>No events yet</b>Press <strong>Fetch now</strong> to run the pipeline.</div>`;
}

// ── Subscriptions ───────────────────────────────────────────────────────────
async function renderSubscriptions() {
  const { subscriptions } = await api('/v1/subscriptions');
  state.subscriptions = subscriptions;

  const select = $('#rule-form select[name="subscription_id"]');
  select.innerHTML = '<option value="">all subscriptions</option>' +
    subscriptions.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');

  $('#subscriptions-list').innerHTML = subscriptions.map((subscription) => {
    const filter = subscription.filter ?? {};
    const parts = [];
    if (filter.categories?.length) parts.push(['categories', filter.categories.join(', ')]);
    if (filter.minSeverity) parts.push(['min severity', `${filter.minSeverity} · ${SEVERITY[filter.minSeverity]}`]);
    if (filter.places?.length) parts.push(['places', filter.places.join(', ')]);
    if (filter.countries?.length) parts.push(['countries', filter.countries.join(', ')]);
    if (filter.near?.length) parts.push(['within', filter.near.map((n) => `${n.radiusKm} km of ${n.label}`).join('; ')]);
    if (filter.geoMatch) parts.push(['geo logic', filter.geoMatch === 'all' ? 'ALL constraints must hold' : 'ANY constraint may hold']);
    if (filter.keywordsAny?.length) parts.push(['mentions any of', filter.keywordsAny.join(', ')]);
    if (filter.keywordsNone?.length) parts.push(['never mentions', filter.keywordsNone.join(', ')]);

    const channels = subscription.delivery?.channels ?? [];

    return `<article class="card" data-subscription="${esc(subscription.id)}">
      <div class="card-top">
        <div style="flex:1">
          <h3>${esc(subscription.name)}</h3>
          <div class="meta">
            <span class="tag">${esc(subscription.review_mode)}</span>
            <span class="tag">threshold ${subscription.threshold}</span>
            <span class="${subscription.active ? 'status-ok' : 'status-warn'}">${subscription.active ? 'active' : 'paused'}</span>
            <span>${channels.length ? `${channels.length} webhook(s)` : 'pull only'}</span>
          </div>
          <dl class="kv">${parts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
        </div>
      </div>
      <div class="row-actions">
        <button data-act="dry-run">Dry run against history</button>
        <button data-act="toggle-active">${subscription.active ? 'Pause' : 'Resume'}</button>
      </div>
      <div class="dry-run-result"></div>
    </article>`;
  }).join('');
}

async function handleSubscriptionAction(card, action) {
  const id = card.dataset.subscription;
  const subscription = state.subscriptions.find((s) => s.id === id);

  if (action === 'toggle-active') {
    await api(`/v1/subscriptions/${id}`, { method: 'PATCH', body: { active: !subscription.active } });
    toast(subscription.active ? 'Paused' : 'Resumed', 'ok');
    return renderSubscriptions();
  }

  if (action === 'dry-run') {
    const target = card.querySelector('.dry-run-result');
    target.innerHTML = '<p class="muted" style="margin-top:12px">Scoring against stored history…</p>';
    const result = await api(`/v1/subscriptions/${id}/test`, { method: 'POST', body: { limit: 500 } });

    target.innerHTML = `<div style="margin-top:12px">
      <p class="muted" style="margin:0 0 9px">
        Scored <strong>${result.tested_against}</strong> stored events —
        <strong>${result.would_match}</strong> would be sent
        (${(result.match_rate * 100).toFixed(0)}% of everything seen).
        ${result.match_rate > 0.5 ? '<span class="status-warn">That is a lot — consider tightening the filter.</span>' : ''}
        ${result.would_match === 0 ? '<span class="status-warn">Nothing matched — the filter may be too tight.</span>' : ''}
      </p>
      ${result.matches.slice(0, 12).map((m) => `<div class="why-row">
          <b>${m.score.toFixed(2)}</b>
          <span class="n">${m.event.severity}</span>
          <span>${esc(m.event.title.slice(0, 92))}</span>
        </div>`).join('')}
    </div>`;
  }
}

// ── Rules ───────────────────────────────────────────────────────────────────
async function renderRules() {
  const { rules } = await api('/v1/rules');
  $('#rules-list').innerHTML = rules.length
    ? rules.map((rule) => `<article class="card" data-rule="${esc(rule.id)}">
        <div class="card-top">
          <div style="flex:1">
            <h3><span class="tag">${esc(rule.kind)}</span>
              ${esc(rule.target)} = <code>${esc(rule.value)}</code></h3>
            <div class="meta">
              <span>weight ${rule.weight}</span>
              <span>${rule.subscription_name ? `only: ${esc(rule.subscription_name)}` : 'all subscriptions'}</span>
              <span>applied ${rule.hits}×</span>
              ${rule.note ? `<span>— ${esc(rule.note)}</span>` : ''}
            </div>
          </div>
          <button class="bad" data-act="delete-rule">Delete</button>
        </div>
      </article>`).join('')
    : `<div class="empty"><b>No rules yet</b>Rules appear here when you reject something with
       “Reject + rule”, or add one above.</div>`;
}

// ── Sources ─────────────────────────────────────────────────────────────────
async function renderSources() {
  const { sources } = await api('/v1/sources');
  $('#sources-list').innerHTML = sources.map((source) => `
    <article class="card" data-source="${esc(source.id)}">
      <div class="card-top">
        <div style="flex:1">
          <h3>${esc(source.name)}</h3>
          <div class="meta">
            <span class="tag">${esc(source.adapter)}</span>
            <span>trust ${source.trust}</span>
            <span>every ${source.poll_seconds}s</span>
            <span class="${source.last_status === 'ok' ? 'status-ok' : source.last_status ? 'status-bad' : 'muted'}">
              ${source.last_status ? `${source.last_status} · ${timeAgo(source.last_polled_at)}` : 'never polled'}
            </span>
          </div>
          ${source.last_error ? `<p class="status-bad" style="margin:7px 0 0;font-size:12px">${esc(source.last_error)}</p>` : ''}
          ${source.config?.url ? `<p class="muted" style="margin:7px 0 0;font-size:12px"><code>${esc(source.config.url)}</code></p>` : ''}
        </div>
        <button data-act="toggle-source">${source.enabled ? 'Disable' : 'Enable'}</button>
      </div>
    </article>`).join('');
}

// ── Stats ───────────────────────────────────────────────────────────────────
async function renderStats() {
  const stats = await api('/v1/admin/stats');
  const approved = stats.curation?.approved ?? 0;
  const total = stats.curation?.total ?? 0;
  const delivered = stats.deliveries
    .filter((d) => d.status === 'succeeded' && d.channel === 'pull')
    .reduce((sum, d) => sum + d.n, 0);

  const cells = [
    ['Events', stats.events],
    ['Active subscriptions', stats.subscriptions],
    ['Awaiting review', stats.pending_review],
    ['Ready to collect', delivered],
    ['Curation rules', stats.rules],
    ['Approval rate', total ? `${Math.round((approved / total) * 100)}%` : '—'],
  ];
  $('#stats').innerHTML = cells.map(([label, value]) =>
    `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`).join('');
}

// ── Tabs & wiring ───────────────────────────────────────────────────────────
const RENDERERS = {
  queue: renderQueue,
  events: renderEvents,
  subscriptions: renderSubscriptions,
  rules: renderRules,
  sources: renderSources,
};

async function show(tab) {
  state.tab = tab;
  $$('header nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.panel').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
  try {
    await RENDERERS[tab]();
  } catch (error) {
    toast(error.message, 'bad');
  }
}

async function refreshAll() {
  await Promise.all([renderStats().catch(() => {}), show(state.tab)]);
}

function wire() {
  $$('header nav button').forEach((button) =>
    button.addEventListener('click', () => show(button.dataset.tab)));

  $('#run-pipeline').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Fetching…';
    try {
      const result = await api('/v1/admin/run', { method: 'POST', body: { force: true } });
      toast(`${result.new_events} new event(s) · ${result.auto_approved} sent · ${result.queued_for_review} to review`, 'ok');
      await refreshAll();
    } catch (error) {
      toast(error.message, 'bad');
    } finally {
      button.disabled = false;
      button.textContent = 'Fetch now';
    }
  });

  $('#sign-out').addEventListener('click', () => {
    localStorage.removeItem('pandora.key');
    location.reload();
  });

  // One delegated listener for every card action, so re-rendering never
  // leaves stale handlers behind.
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-act]');
    if (!button) return;
    const action = button.dataset.act;

    try {
      if (action === 'delete-rule') {
        await api(`/v1/rules/${button.closest('[data-rule]').dataset.rule}`, { method: 'DELETE' });
        toast('Rule deleted');
        return renderRules();
      }
      if (action === 'toggle-source') {
        const card = button.closest('[data-source]');
        await api(`/v1/sources/${card.dataset.source}`, {
          method: 'PATCH', body: { enabled: button.textContent.trim() === 'Enable' },
        });
        return renderSources();
      }
      const matchCard = button.closest('[data-match]');
      if (matchCard) return await handleQueueAction(matchCard, action);
      const subscriptionCard = button.closest('[data-subscription]');
      if (subscriptionCard) return await handleSubscriptionAction(subscriptionCard, action);
    } catch (error) {
      toast(error.message, 'bad');
    }
  });

  $('#rule-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await api('/v1/rules', {
        method: 'POST',
        body: {
          kind: data.kind,
          target: data.target,
          value: data.value,
          weight: Number(data.weight),
          subscription_id: data.subscription_id || null,
          note: 'Added from the console',
        },
      });
      event.currentTarget.reset();
      toast('Rule added', 'ok');
      await renderRules();
    } catch (error) {
      toast(error.message, 'bad');
    }
  });
}

async function boot() {
  try {
    const me = await api('/v1/me');
    const health = await (await fetch('/healthz')).json();
    $('#mode-badge').textContent = `${me.name} · ${health.mode} mode`;
    $('#gate').hidden = true;
    $('#app').hidden = false;
    wire();
    await refreshAll();
    setInterval(() => renderStats().catch(() => {}), 30000);
  } catch {
    $('#gate').hidden = false;
    $('#app').hidden = true;
  }
}

$('#gate-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  state.key = $('#gate-key').value.trim();
  try {
    await api('/v1/me');
    localStorage.setItem('pandora.key', state.key);
    location.reload();
  } catch {
    $('#gate-error').textContent = 'That key was not accepted.';
    $('#gate-error').hidden = false;
  }
});

if (state.key) boot();
