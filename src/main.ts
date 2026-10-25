import './styles.css';
import { diffGraphs } from './core/diff';
import { NO_FILTER, applyFilter, failureCount, isUnfiltered, matches, type ListFilter } from './core/filter';
import type { VGraph } from './core/history';
import { WorkflowFeed, type FeedEvent } from './feed';
import { GraphView, STATE_COLOR, formatDuration } from './render';
import { ReplayApi } from './replay';
import { ApiError, TemporalApi, type HistoryApi, type WorkflowSummary } from './temporal';
import sample from './sample-history.json';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  ns: $<HTMLInputElement>('ns'), query: $<HTMLInputElement>('query'), list: $('list'),
  reload: $('reload'), filters: $('filters'), note: $('new-note'), announce: $('announce'), sample: $('sample'), title: $('wf-title'), status: $('wf-status'),
  auto: $<HTMLInputElement>('auto'), fit: $('fit'), banner: $('banner'), empty: $('empty'),
  canvas: $<HTMLCanvasElement>('c'), detail: $('detail'), live: $('live'), liveText: $('live-text'),
};

const STATUS_COLOR: Record<string, string> = {
  RUNNING: '#2F63C8', COMPLETED: '#1B7F63', CONTINUED_AS_NEW: '#1B7F63', FAILED: '#BF3A30',
  TIMED_OUT: '#8E3F86', CANCELED: '#5B6670', TERMINATED: '#5B6670',
};
const statusText = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replaceAll('_', ' ');

let api = new TemporalApi(el.ns.value);
let feed: WorkflowFeed | null = null;
let replay: ReplayApi | null = null;
let current: { workflowId: string; runId: string; sample?: boolean } | null = null;
let graph: VGraph | null = null;
let selectedId: string | null = null;
let changes: { id: number; time: string; text: string }[] = [];
let changeSeq = 0;

const view = new GraphView(el.canvas, (v) => { selectedId = v?.id ?? null; renderDetail(); });

// ---------- helpers ----------
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string> = {}, ...kids: (string | Node)[]) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) node.setAttribute(k, v);
  node.append(...kids);
  return node;
}
function showBanner(msg: string | Node | null, warn = false) {
  el.banner.hidden = !msg;
  el.banner.className = warn ? 'warn' : '';
  el.banner.replaceChildren(...(msg ? [typeof msg === 'string' ? document.createTextNode(msg) : msg] : []));
}
function explain(err: unknown): Node {
  const wrap = document.createElement('span');
  if (err instanceof ApiError) {
    wrap.append(
      'Couldn’t read from the Temporal UI API ',
      h('code', {}, err.url),
      err.httpStatus ? ` (HTTP ${err.httpStatus}${err.message ? `: ${err.message}` : ''}). ` : `. ${err.message} `,
      'Check that ', h('code', {}, 'temporal server start-dev'), ' is running and that the dev proxy points at its UI port (default 8233, set TEMPORAL_UI to change).',
    );
  } else wrap.append(String(err));
  return wrap;
}
const clock = (d = new Date()) => d.toLocaleTimeString([], { hour12: false });
const fmtTime = (s?: string) => (s ? clock(new Date(s)) + '.' + String(new Date(s).getMilliseconds()).padStart(3, '0') : '');

function setLive(mode: 'idle' | 'long-poll' | 'poll' | 'closed' | 'paused' | 'error') {
  el.live.dataset.mode = mode;
  el.liveText.textContent = {
    idle: 'Not connected', 'long-poll': 'Live, pushed by server', poll: 'Live, polling every second',
    closed: 'Workflow closed', paused: 'Updates paused', error: 'Connection problem',
  }[mode];
}

// ---------- workflow list ----------
let items: WorkflowSummary[] = [];
let filter: ListFilter = { ...NO_FILTER };

const ICON = {
  all: '<rect x="1.5" y="1.5" width="4.5" height="4.5" rx="1"/><rect x="10" y="10" width="4.5" height="4.5" rx="1"/><circle cx="12" cy="3.8" r="2.3"/><path d="M6 3.8h3.7M3.7 6v6H10"/>',
  smile: '<circle cx="8" cy="8" r="6.5"/><path d="M5.3 9.6c1.5 1.6 3.9 1.6 5.4 0"/><path d="M5.8 6.2v.01M10.2 6.2v.01" stroke-width="2"/>',
  frown: '<circle cx="8" cy="8" r="6.5"/><path d="M5.3 11c1.5-1.6 3.9-1.6 5.4 0"/><path d="M5.8 6.2v.01M10.2 6.2v.01" stroke-width="2"/>',
  pulse: '<path d="M1 8h3.2l2-5 3.4 10 2.2-5H15"/>',
  parent: '<rect x="6" y="1.5" width="4" height="3.5" rx=".8"/><rect x="1.5" y="11" width="4" height="3.5" rx=".8"/><rect x="10.5" y="11" width="4" height="3.5" rx=".8"/><path d="M8 5v3M3.5 11V8h9v3"/>',
  today: '<rect x="2" y="3" width="12" height="11" rx="1.6"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"/>',
  hour: '<circle cx="8" cy="8" r="6.5"/><path d="M8 4.5V8l2.5 1.5"/>',
};
const svg = (inner: string) => `<svg viewBox="0 0 16 16" aria-hidden="true">${inner}</svg>`;

function renderFilters() {
  const failures = failureCount(items, filter);
  const chip = (label: string, icon: string, pressed: boolean, onClick: () => void, badge?: number) => {
    const b = h('button', { type: 'button', class: 'chip-btn', 'aria-pressed': String(pressed) });
    b.insertAdjacentHTML('afterbegin', svg(icon));   // icons are constants defined above
    b.append(label);
    if (badge !== undefined) b.append(h('span', { class: 'chip-badge', 'data-n': String(badge), 'aria-label': `${badge} found` }, String(badge)));
    b.addEventListener('click', onClick);
    return b;
  };
  const set = (patch: Partial<ListFilter>) => { filter = { ...filter, ...patch }; renderList(); };
  const toggle = <K extends 'status' | 'time'>(key: K, value: NonNullable<ListFilter[K]>) =>
    set({ [key]: filter[key] === value ? null : value } as Partial<ListFilter>);

  el.filters.replaceChildren(
    h('div', { class: 'chip-row' },
      chip('All', ICON.all, isUnfiltered(filter), () => set({ ...NO_FILTER })),
      chip('Failures', failures ? ICON.frown : ICON.smile, filter.status === 'failures', () => toggle('status', 'failures'), failures),
      chip('Running', ICON.pulse, filter.status === 'running', () => toggle('status', 'running')),
    ),
    h('div', { class: 'chip-row' },
      chip('Parent', ICON.parent, filter.parent, () => set({ parent: !filter.parent })),
      chip('Today', ICON.today, filter.time === 'today', () => toggle('time', 'today')),
      chip('Last 1h', ICON.hour, filter.time === 'hour', () => toggle('time', 'hour')),
    ),
  );
}

// How long a new run blinks, keeps its "New" tag, and is mentioned in the notice.
const BLINK_MS = 3600;
const TAG_MS = 30_000;
const NOTE_MS = 20_000;
const PULSE_MS = 1800;

const keyOf = (w: WorkflowSummary) => `${w.workflowId}/${w.runId}`;
const known = new Set<string>();
const firstSeen = new Map<string, number>();
const lastStatus = new Map<string, string>();
const statusChangedAt = new Map<string, number>();
let baseline = '';
let listLoading = false;
let lastSignature = '';
let expiryTimer: number | undefined;

/** Compares a fresh listing with the previous one and records what is new or changed. */
function trackChanges(fresh: WorkflowSummary[]) {
  const base = `${el.ns.value.trim() || 'default'}|${el.query.value.trim()}`;
  const now = Date.now();
  if (base !== baseline) {                     // first load, or a different namespace/query: nothing is "new"
    baseline = base;
    known.clear(); firstSeen.clear(); lastStatus.clear(); statusChangedAt.clear();
    for (const w of fresh) { known.add(keyOf(w)); lastStatus.set(keyOf(w), w.status); }
    return;
  }
  const arrived: WorkflowSummary[] = [];
  for (const w of fresh) {
    const k = keyOf(w);
    if (!known.has(k)) { known.add(k); firstSeen.set(k, now); arrived.push(w); }
    else if (lastStatus.get(k) !== w.status) statusChangedAt.set(k, now);
    lastStatus.set(k, w.status);
  }
  if (arrived.length) {
    el.announce.textContent = arrived.length === 1
      ? `New workflow started: ${arrived[0].type} ${arrived[0].workflowId}`
      : `${arrived.length} new workflows started`;
  }
}

async function loadList(opts: { silent?: boolean } = {}) {
  if (opts.silent && listLoading) return;
  listLoading = true;
  api = new TemporalApi(el.ns.value.trim() || 'default');
  if (!opts.silent) el.list.replaceChildren(h('li', { class: 'list-note' }, 'Loading…'));
  try {
    const fresh = await api.list(el.query.value);
    trackChanges(fresh);
    items = fresh;
    if (!opts.silent) { showBanner(null); lastSignature = ''; }   // the "Loading…" row replaced the DOM
    renderList();
  } catch (err) {
    if (opts.silent) return;               // keep showing the last good list
    items = [];
    lastSignature = '';
    renderFilters();
    el.list.replaceChildren(h('li', { class: 'list-note' }, 'The list couldn’t be loaded.'));
    showBanner(explain(err));
  } finally {
    listLoading = false;
  }
}

function renderList() {
  renderFilters();
  const now = Date.now();
  const shown = applyFilter(items, filter);
  const age = (m: Map<string, number>, k: string) => (m.has(k) ? now - m.get(k)! : Infinity);

  // Re-render only when something visible changed, so keyboard focus and hover survive the background refresh.
  const rows = shown.map((w) => {
    const k = keyOf(w);
    return [k, w.status, w.historyLength, age(firstSeen, k) < BLINK_MS, age(firstSeen, k) < TAG_MS, age(statusChangedAt, k) < PULSE_MS];
  });
  const signature = JSON.stringify([rows, items.length]);
  updateNote(now);
  scheduleExpiry(now);
  if (signature === lastSignature) return;
  lastSignature = signature;

  const focusedKey = el.list.contains(document.activeElement)
    ? (document.activeElement as HTMLElement).closest('li')?.getAttribute('data-key') ?? null : null;

  if (!shown.length) {
    const note = h('li', { class: 'list-note' }, items.length
      ? `None of the ${items.length} loaded workflows match these filters.`
      : 'No workflows in this namespace match the query.');
    if (items.length) {
      const clear = h('button', { type: 'button' }, 'Show all');
      clear.addEventListener('click', () => { filter = { ...NO_FILTER }; renderList(); });
      note.append(clear);
    }
    el.list.replaceChildren(note);
    return;
  }

  el.list.replaceChildren(...shown.map((w) => {
    const k = keyOf(w);
    const sinceNew = age(firstSeen, k);
    const sinceChange = age(statusChangedAt, k);
    const status = w.status;
    const dot = h('span', { class: 'dot', style: `background:${STATUS_COLOR[status] ?? '#6F7F90'}` });
    const top = h('div', { class: 'li-top' }, dot, w.type || 'Workflow');
    if (sinceNew < TAG_MS) top.append(h('span', { class: 'li-tag' }, 'New'));
    const btn = h('button', { type: 'button' },
      top,
      h('div', { class: 'li-id' }, w.workflowId),
      h('div', { class: 'li-meta' }, `${statusText(status || 'unknown')}${w.historyLength ? `, ${w.historyLength} events` : ''}${w.parentWorkflowId ? ', child workflow' : ''}`),
    );
    if (current && current.workflowId === w.workflowId && current.runId === w.runId) btn.setAttribute('aria-current', 'true');
    btn.addEventListener('click', () => openWorkflow(w.workflowId, w.runId));
    const classes = [sinceNew < BLINK_MS ? 'is-blinking' : '', sinceChange < PULSE_MS ? 'is-pulsing' : ''].filter(Boolean).join(' ');
    const li = h('li', { 'data-key': k, ...(classes ? { class: classes } : {}) }, btn);
    li.style.setProperty('--elapsed', `${Math.min(sinceNew < BLINK_MS ? sinceNew : sinceChange, 60_000)}ms`);
    return li;
  }));

  if (focusedKey) {
    const again = [...el.list.querySelectorAll('li')].find((x) => x.getAttribute('data-key') === focusedKey);
    again?.querySelector('button')?.focus({ preventScroll: true });
  }
  requestAnimationFrame(() => updateNote(Date.now()));
}

/** Tells the user about new runs they cannot see: hidden by a filter, or scrolled out of view above. */
function updateNote(now: number) {
  const recent = items.filter((w) => now - (firstSeen.get(keyOf(w)) ?? -Infinity) < NOTE_MS);
  const hidden = recent.filter((w) => !matches(w, filter, now)).length;
  let above = 0;
  if (!hidden) {
    const top = el.list.getBoundingClientRect().top;
    for (const li of el.list.querySelectorAll('li[data-key]')) {
      const k = li.getAttribute('data-key')!;
      if (now - (firstSeen.get(k) ?? -Infinity) < NOTE_MS && li.getBoundingClientRect().bottom <= top + 4) above++;
    }
  }
  const n = hidden || above;
  if (!n) { el.note.hidden = true; return; }
  const noun = n === 1 ? 'workflow' : 'workflows';
  const btn = h('button', { type: 'button' }, hidden ? 'Show all' : 'Jump to top');
  btn.addEventListener('click', () => {
    if (hidden) { filter = { ...NO_FILTER }; renderList(); }
    el.list.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
  });
  el.note.replaceChildren(h('span', {}, hidden ? `${n} new ${noun} hidden by the filters` : `${n} new ${noun} above`), btn);
  el.note.hidden = false;
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Re-renders when the blink, tag or notice of some row runs out, so those states clear on their own. */
function scheduleExpiry(now: number) {
  window.clearTimeout(expiryTimer);
  const deadlines: number[] = [];
  for (const t of firstSeen.values()) for (const span of [BLINK_MS, TAG_MS, NOTE_MS]) if (now - t < span) deadlines.push(t + span - now);
  for (const t of statusChangedAt.values()) if (now - t < PULSE_MS) deadlines.push(t + PULSE_MS - now);
  if (deadlines.length) expiryTimer = window.setTimeout(renderList, Math.min(...deadlines) + 60);
}

function markCurrent() {
  el.list.querySelectorAll('button').forEach((b) => b.removeAttribute('aria-current'));
  [...el.list.querySelectorAll('li')].forEach((li) => {
    const id = li.querySelector('.li-id')?.textContent;
    if (id && id === current?.workflowId) li.querySelector('button')?.setAttribute('aria-current', 'true');
  });
}

// ---------- following a workflow ----------
function stopFeed() {
  feed?.stop();
  feed = null;
}

function openWorkflow(workflowId: string, runId: string, source?: HistoryApi, opts: { resumeFrom?: VGraph | null } = {}) {
  stopFeed();
  if (!source) { replay?.stop(); replay = null; }
  current = { workflowId, runId, sample: source !== undefined };
  if (!opts.resumeFrom) { graph = null; selectedId = null; changes = []; }
  if (!source) location.hash = `${encodeURIComponent(workflowId)}/${encodeURIComponent(runId)}`;
  const f = new WorkflowFeed(source ?? api, workflowId, runId);
  feed = f;
  f.subscribe((e) => { if (feed === f) onFeed(e, opts.resumeFrom ?? null); });
  setLive(el.auto.checked ? 'long-poll' : 'paused');
  markCurrent();
  void f.start({ follow: el.auto.checked });
}

function onFeed(e: FeedEvent, resumeFrom: VGraph | null) {
  switch (e.type) {
    case 'snapshot': {
      showBanner(current?.sample ? 'Replaying built-in sample data as a live run. It is not read from your Temporal server.' : null, true);
      el.empty.hidden = true;
      const prev = resumeFrom ?? null;
      graph = e.graph;
      renderHeader(e.graph);
      if (prev) view.update(e.graph, diffGraphs(prev, e.graph));
      else view.reset(e.graph, { fit: true });
      renderDetail();
      if (e.graph.status !== 'RUNNING') setLive('closed');
      break;
    }
    case 'update': {
      graph = e.graph;
      renderHeader(e.graph);
      view.update(e.graph, e.diff);
      for (const text of e.messages) changes.unshift({ id: ++changeSeq, time: clock(), text });
      changes = changes.slice(0, 40);
      if (el.auto.checked) {
        const newest = [...e.diff.addedNodes].reverse().find((n) => n.kind !== 'end') ?? e.diff.changedNodes[0]?.next;
        if (newest) view.revealIfOffscreen(newest.id);
      }
      const selectedChanged = selectedId && (e.diff.changedNodes.some((c) => c.next.id === selectedId));
      if (!selectedId || selectedChanged) renderDetail();
      break;
    }
    case 'mode': setLive(e.mode); break;
    case 'closed': setLive('closed'); renderHeader(e.graph); break;
    case 'error': setLive('error'); showBanner(explain(e.error)); break;
  }
}

function renderHeader(g: VGraph) {
  el.title.textContent = `${g.workflowType || 'Workflow'}  ${current?.workflowId ?? ''}`.trim();
  el.status.hidden = false;
  el.status.textContent = statusText(g.status);
  el.status.style.background = STATUS_COLOR[g.status] ?? '#6F7F90';
}

function openSample() {
  stopFeed();
  replay?.stop();
  const events = (sample as { history: { events: never[] } }).history.events;
  replay = new ReplayApi(events);
  el.auto.checked = true;
  openWorkflow('order-A-1042', 'sample', replay);
}

// ---------- details ----------
function renderDetail() {
  if (!graph) { el.detail.replaceChildren(h('p', { class: 'sub' }, 'Select a step to see its timing, input, result and events.')); return; }
  const v = graph.nodes.find((n) => n.id === selectedId);
  if (!v) return renderSummary(graph);
  const rows: [string, string][] = [
    ['State', STATE_COLOR[v.state].label],
    ...(v.attempt ? [['Attempt', v.maxAttempts ? `${v.attempt} of ${v.maxAttempts}` : String(v.attempt)] as [string, string]] : []),
    ...(v.durationMs != null ? [['Duration', formatDuration(v.durationMs)] as [string, string]] : []),
    ...(v.scheduledAt ? [['Scheduled', fmtTime(v.scheduledAt)] as [string, string]] : []),
    ...(v.startedAt && v.startedAt !== v.scheduledAt ? [['Started', fmtTime(v.startedAt)] as [string, string]] : []),
    ...(v.closedAt ? [['Closed', fmtTime(v.closedAt)] as [string, string]] : []),
    ...Object.entries(v.detail).filter(([, val]) => val),
  ];
  const parts: Node[] = [
    h('h3', {}, v.label), h('div', { class: 'sub' }, v.kind === 'localActivity' ? 'Local activity' : v.kind),
    h('dl', {}, ...rows.flatMap(([k, val]) => [h('dt', {}, k), h('dd', {}, val)])),
  ];
  if (v.failure) parts.push(h('h4', {}, 'Failure'), h('pre', { class: 'err' }, v.failure));
  if (v.input) parts.push(h('h4', {}, 'Input'), h('pre', {}, v.input));
  if (v.result) parts.push(h('h4', {}, 'Result'), h('pre', {}, v.result));
  parts.push(h('h4', {}, 'History events'), h('ul', { class: 'events' }, ...v.events.map((e) =>
    h('li', {}, h('span', { class: 'id' }, String(e.id)), h('span', {}, e.type.toLowerCase().replaceAll('_', ' ')), h('span', { class: 'tm' }, fmtTime(e.time))))));
  el.detail.replaceChildren(...parts);
}
function renderSummary(g: VGraph) {
  const start = g.nodes.find((n) => n.kind === 'start');
  const end = g.nodes.find((n) => n.kind === 'end');
  const parts: Node[] = [h('h3', {}, g.workflowType || 'Workflow'), h('div', { class: 'sub' }, 'Select a step for details.')];
  if (g.warnings.length) parts.push(h('div', { class: 'warnings' }, ...g.warnings.map((w) => h('p', {}, w))));
  parts.push(h('dl', {},
    h('dt', {}, 'Status'), h('dd', {}, statusText(g.status)),
    h('dt', {}, 'Workflow ID'), h('dd', {}, current?.workflowId ?? ''),
    h('dt', {}, 'Run ID'), h('dd', {}, current?.runId ?? ''),
    h('dt', {}, 'Steps'), h('dd', {}, String(g.nodes.filter((n) => n.kind !== 'start' && n.kind !== 'end').length)),
    ...(end?.durationMs != null ? [h('dt', {}, 'Total time'), h('dd', {}, formatDuration(end.durationMs))] : []),
    ...(start?.detail['Task queue'] ? [h('dt', {}, 'Task queue'), h('dd', {}, start.detail['Task queue'])] : []),
  ));
  if (end?.failure) parts.push(h('h4', {}, 'Workflow failure'), h('pre', { class: 'err' }, end.failure));
  if (changes.length) {
    parts.push(h('h4', {}, 'Recent changes'), h('ul', { class: 'changes' }, ...changes.slice(0, 15).map((c, i) =>
      h('li', i === 0 ? { class: 'fresh' } : {}, h('span', { class: 'tm' }, c.time), h('span', {}, c.text)))));
  }
  el.detail.replaceChildren(...parts);
}

// ---------- wiring ----------
el.reload.addEventListener('click', () => loadList());
el.query.addEventListener('keydown', (e) => { if (e.key === 'Enter') void loadList(); });
el.ns.addEventListener('change', () => loadList());
el.sample.addEventListener('click', openSample);
el.fit.addEventListener('click', () => view.fit());
el.auto.addEventListener('change', () => {
  if (!current) return;
  if (!el.auto.checked) { stopFeed(); setLive('paused'); return; }
  // Resume: reload the current state and apply it as changes, keeping the view where it is.
  openWorkflow(current.workflowId, current.runId, current.sample ? (replay ?? undefined) : undefined, { resumeFrom: graph });
});
setInterval(() => { if (!document.hidden) void loadList({ silent: true }); }, 2000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void loadList({ silent: true }); });
el.list.addEventListener('scroll', () => updateNote(Date.now()), { passive: true });
window.addEventListener('beforeunload', () => { stopFeed(); replay?.stop(); });

renderDetail();
loadList().then(() => {
  const [w, r] = location.hash.slice(1).split('/').map(decodeURIComponent);
  if (w && r) openWorkflow(w, r);
});
