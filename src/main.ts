import './styles.css';
import { diffGraphs } from './core/diff';
import { NO_FILTER, applyFilter, failureCount, isUnfiltered, matches, type ListFilter } from './core/filter';
import type { HistoryEvent, VGraph } from './core/history';
import { classifyFrame, failureText, groupFailures, groupsText, outcomeWords, shortType, type FailureItem } from './core/failure';
import { fmtOffset } from './core/timeline';
import { copyButton, h, iconOpen } from './dom';
import { WorkflowFeed, type FeedEvent } from './feed';
import { GraphView, STATE_COLOR, formatDuration } from './render';
import { ReplayApi } from './replay';
import { Scrubber } from './scrubber';
import { initSidebar } from './sidebar';
import { ApiError, TemporalApi, type HistoryApi, type WorkflowSummary } from './temporal';
import sample from './sample-history.json';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  ns: $<HTMLInputElement>('ns'), query: $<HTMLInputElement>('query'), list: $('list'),
  reload: $('reload'), filters: $('filters'), note: $('new-note'), announce: $('announce'), sample: $('sample'), title: $('wf-title'), status: $('wf-status'),
  auto: $<HTMLInputElement>('auto'), fit: $('fit'), banner: $('banner'), empty: $('empty'),
  canvas: $<HTMLCanvasElement>('c'), detail: $('detail-body'), live: $('live'), liveText: $('live-text'),
  ids: $('wf-ids'), openUi: $<HTMLAnchorElement>('open-ui'), tabDetails: $('tab-details'), tabFailures: $('tab-failures'), failCount: $('fail-count'),
};

const sidebar = initSidebar({
  app: $('app'), side: $('side'), handle: $('resizer'),
  collapse: $<HTMLButtonElement>('collapse'), expand: $<HTMLButtonElement>('expand'),
  railBadge: $('rail-badge'), railDot: $('rail-dot'),
});

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
let tab: 'details' | 'failures' = 'details';
let groupBy: 'type' | 'message' = 'type';
/** The whole run as last loaded; stepping through the replay changes `graph`, not this. */
let runGraph: VGraph | null = null;
const groupOpen = new Map<string, boolean>();
const traceOpen = new Set<string>();

const view = new GraphView(el.canvas, (v) => { selectedId = v?.id ?? null; if (v) tab = 'details'; renderDetail(); });

// Replay scrubber: steps through a finished run. Each step is applied to the canvas like a live update.
const scrubber = new Scrubber($('scrubber'), (c) => {
  graph = c.graph;
  view.update(c.graph, c.diff);
  renderDetail();
});
function offerReplay(events: HistoryEvent[], finalGraph: VGraph) {
  if (finalGraph.status === 'RUNNING') return;
  view.pinLayout(finalGraph);
  scrubber.load(events, finalGraph);
}
function closeReplay() { scrubber.unload(); view.pinLayout(null); }

// ---------- helpers ----------
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
  sidebar.setFailures(failureCount(items, NO_FILTER));
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
    sidebar.flagNew();
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
  closeReplay();
  if (!source) { replay?.stop(); replay = null; }
  current = { workflowId, runId, sample: source !== undefined };
  if (!opts.resumeFrom) { graph = null; runGraph = null; selectedId = null; changes = []; groupOpen.clear(); traceOpen.clear(); }
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
      graph = e.graph; runGraph = e.graph;
      renderHeader(e.graph);
      if (prev) view.update(e.graph, diffGraphs(prev, e.graph));
      else view.reset(e.graph, { fit: true });
      renderDetail();
      if (e.graph.status !== 'RUNNING') { setLive('closed'); offerReplay(feed!.history, e.graph); }
      break;
    }
    case 'update': {
      graph = e.graph; runGraph = e.graph;
      renderHeader(e.graph);
      view.update(e.graph, e.diff);
      for (const text of e.messages) changes.unshift({ id: ++changeSeq, time: clock(), text });
      changes = changes.slice(0, 40);
      if (el.auto.checked) {
        const newest = [...e.diff.addedNodes].reverse().find((n) => n.kind !== 'end') ?? e.diff.changedNodes[0]?.next;
        if (newest) view.revealIfOffscreen(newest.id);
      }
      const selectedChanged = selectedId && (e.diff.changedNodes.some((c) => c.next.id === selectedId));
      if (!selectedId || selectedChanged || tab === 'failures') renderDetail(); else syncTabs();
      break;
    }
    case 'mode': setLive(e.mode); break;
    case 'closed': runGraph = e.graph; setLive('closed'); renderHeader(e.graph); offerReplay(feed!.history, e.graph); break;
    case 'error': setLive('error'); showBanner(explain(e.error)); break;
  }
}

function renderHeader(g: VGraph) {
  el.title.textContent = g.workflowType || 'Workflow';     // the IDs are in the chips below
  el.status.hidden = false;
  el.status.textContent = statusText(g.status);
  el.status.style.background = STATUS_COLOR[g.status] ?? '#6F7F90';
  const wid = current?.workflowId ?? '', rid = current?.runId ?? '';
  const chip = (key: string, what: string, value: string) => { const b = copyButton(what, () => value, value, 'id-chip'); b.dataset.key = key; return b; };
  el.ids.replaceChildren(chip('workflow', 'workflow ID', wid), chip('run', 'run ID', rid));
  el.openUi.hidden = !!current?.sample || !wid;
  if (!el.openUi.hidden) { el.openUi.href = uiUrl(wid, rid); el.openUi.replaceChildren(iconOpen(), 'Open in Temporal UI'); }
}

/** Page of a run in the Temporal Web UI. */
const uiUrl = (wid: string, rid: string) =>
  `${__TEMPORAL_UI_URL__}/namespaces/${encodeURIComponent(api.namespace)}/workflows/${encodeURIComponent(wid)}/${encodeURIComponent(rid)}/history`;
function openLink(href: string, label: string) {
  const a = h('a', { class: 'btn', href, target: '_blank', rel: 'noopener noreferrer' }, label);
  a.prepend(iconOpen()); return a;
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
  syncTabs();
  if (tab === 'failures') return renderFailures();
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
    h('dl', {}, ...rows.flatMap(([k, val]) => [h('dt', {}, k), h('dd', {}, val, ...(/\bID$/i.test(k) && val ? [copyButton(k, () => val)] : []))])),
  ];
  if (v.kind === 'child' && v.detail['Workflow ID'] && v.detail['Run ID'] && !current?.sample) {
    parts.push(h('div', { class: 'actions' }, openLink(uiUrl(v.detail['Workflow ID'], v.detail['Run ID']), 'Open child in Temporal UI')));
  }
  const mine = (graph.failures ?? []).filter((f) => f.nodeId === v.id);
  if (mine.length) mine.forEach((f) => parts.push(h('h4', {}, mine.length > 1 ? 'Failure' : 'Failure'), failureBlock(f)));
  else if (v.failure) parts.push(h('h4', {}, 'Failure'), h('pre', { class: 'err' }, v.failure));
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
    h('dt', {}, 'Workflow ID'), h('dd', {}, current?.workflowId ?? '', copyButton('workflow ID', () => current?.workflowId ?? '')),
    h('dt', {}, 'Run ID'), h('dd', {}, current?.runId ?? '', copyButton('run ID', () => current?.runId ?? '')),
    h('dt', {}, 'Steps'), h('dd', {}, String(g.nodes.filter((n) => n.kind !== 'start' && n.kind !== 'end').length)),
    ...(end?.durationMs != null ? [h('dt', {}, 'Total time'), h('dd', {}, formatDuration(end.durationMs))] : []),
    ...(start?.detail['Task queue'] ? [h('dt', {}, 'Task queue'), h('dd', {}, start.detail['Task queue'])] : []),
  ));
  const nFail = (runGraph?.failures ?? []).filter((f) => !f.duplicateOf).length;
  if (nFail) {
    const groups = groupFailures(runGraph!.failures, groupBy).length;
    const b = h('button', { type: 'button', class: 'review-btn' }, `Review ${nFail} failure${nFail === 1 ? '' : 's'} in ${groups} group${groups === 1 ? '' : 's'}`);
    b.addEventListener('click', () => setTab('failures'));
    parts.push(b);
  } else if (end?.failure) parts.push(h('h4', {}, 'Workflow failure'), h('pre', { class: 'err' }, end.failure));
  if (scrubber.visible) {
    parts.push(h('h4', {}, 'Timeline'), timelineList());
  } else if (changes.length) {
    parts.push(h('h4', {}, 'Recent changes'), h('ul', { class: 'changes' }, ...changes.slice(0, 15).map((c, i) =>
      h('li', i === 0 ? { class: 'fresh' } : {}, h('span', { class: 'tm' }, c.time), h('span', {}, c.text)))));
  }
  el.detail.replaceChildren(...parts);
}

// ---------- failure triage ----------
function setTab(t: 'details' | 'failures') { tab = t; renderDetail(); }
function syncTabs() {
  const n = (runGraph?.failures ?? []).filter((f) => !f.duplicateOf).length;
  el.failCount.textContent = String(n); el.failCount.dataset.n = String(n);
  el.tabDetails.setAttribute('aria-selected', String(tab === 'details'));
  el.tabFailures.setAttribute('aria-selected', String(tab === 'failures'));
}
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const firstLine = (s: string, max = 130) => { const l = s.split('\n')[0].trim(); return l.length > max ? l.slice(0, max - 1) + '…' : l; };

function stackBlock(stack: string, open: boolean): HTMLElement {
  const lines = stack.split('\n');
  const fw = lines.filter((l) => classifyFrame(l) === 'framework').length;
  const pre = h('pre', { class: 'stack', tabindex: '0' });
  lines.forEach((l, i) => pre.append(h('span', { class: `fr fr-${classifyFrame(l)}` }, l + (i < lines.length - 1 ? '\n' : ''))));
  const det = h('details', { class: 'f-stack' });
  det.open = open;
  const tools = h('div', { class: 'stack-tools' }, copyButton('stack trace', () => stack, 'Copy'));
  if (fw) {
    const t = h('button', { type: 'button', class: 'copy-btn', 'aria-pressed': 'false' }, 'Hide framework frames');
    t.addEventListener('click', () => { const hide = pre.classList.toggle('hide-fw'); t.setAttribute('aria-pressed', String(hide)); t.textContent = hide ? 'Show framework frames' : 'Hide framework frames'; });
    tools.append(t);
  }
  det.append(h('summary', {}, `Stack trace (${lines.length} lines${fw ? `, ${fw} from the JDK or SDK` : ''})`), tools, pre);
  return det;
}
function linkBlock(l: FailureItem['detail']['chain'][number], root: boolean): HTMLElement {
  const box = h('div', { class: root ? 'f-link root' : 'f-link' });
  box.append(h('div', { class: 'f-type' }, l.type ?? l.kind, ...(l.nonRetryable ? [h('span', { class: 'f-tag' }, 'non-retryable')] : [])));
  if (l.message) box.append(h('div', { class: 'f-msg' }, l.message));
  if (l.info) box.append(h('div', { class: 'f-info' }, l.info));
  if (l.stack) box.append(stackBlock(l.stack, root));
  return box;
}
/** One failure in full: the root cause with its stack trace first, the wrapping failures folded below. */
function failureBlock(it: FailureItem): HTMLElement {
  const start = runGraph?.nodes.find((n) => n.kind === 'start')?.startedAt;
  const ms = it.time && start ? Date.parse(it.time) - Date.parse(start) : NaN;
  const chain = it.detail.chain;
  const box = h('div', { class: 'failure', 'data-outcome': it.outcome },
    h('div', { class: 'f-head' },
      h('span', { class: 'f-outcome' }, capital(outcomeWords(it.outcome))),
      h('span', { class: 'f-when' }, `${Number.isFinite(ms) ? fmtOffset(ms) + ' · ' : ''}event #${it.eventId}`),
      copyButton('failure details', () => failureText(it), 'Copy failure')),
    linkBlock(chain[chain.length - 1], true));
  if (chain.length > 1) {
    const det = h('details', { class: 'f-wrap' }, h('summary', {}, `Wrapped by ${chain.length - 1} failure${chain.length > 2 ? 's' : ''}`));
    [...chain.slice(0, -1)].reverse().forEach((l) => det.append(linkBlock(l, false)));
    box.append(det);
  }
  return box;
}

/** Selects the failing step, centres it and shows its stack trace. If the replay is earlier than the failure, it moves forward. */
function jumpToFailure(it: FailureItem) {
  if (scrubber.visible) scrubber.ensureAt(it.eventId);
  if (!it.nodeId) { traceOpen.has(it.id) ? traceOpen.delete(it.id) : traceOpen.add(it.id); renderDetail(); return; }
  tab = 'details';
  if (!view.focusNode(it.nodeId)) renderDetail();
}

function renderFailures() {
  if (!runGraph) { el.detail.replaceChildren(h('p', { class: 'sub' }, 'Open a workflow to see its failures.')); return; }
  const real = runGraph.failures.filter((f) => !f.duplicateOf);
  const groups = groupFailures(runGraph.failures, groupBy);
  const parts: Node[] = [h('h3', {}, 'Failures'),
    h('div', { class: 'sub' }, real.length ? `${real.length} failure${real.length === 1 ? '' : 's'} in ${groups.length} group${groups.length === 1 ? '' : 's'}` : 'Nothing has failed in this run.')];
  if (!real.length) { el.detail.replaceChildren(...parts); return; }

  const seg = (label: string, v: 'type' | 'message') => {
    const b = h('button', { type: 'button', 'aria-pressed': String(groupBy === v) }, label);
    b.addEventListener('click', () => { groupBy = v; groupOpen.clear(); renderDetail(); });
    return b;
  };
  parts.push(h('div', { class: 'f-controls' },
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Group failures by' }, seg('By type', 'type'), seg('By message', 'message')),
    copyButton('failure summary', () => groupsText(groups, `${runGraph!.workflowType || 'Workflow'} ${current?.workflowId ?? ''}`.trim()), 'Copy as text')));

  const start = runGraph.nodes.find((n) => n.kind === 'start')?.startedAt;
  const nowEvent = scrubber.visible ? scrubber.steps[scrubber.p - 1]?.eventId ?? Infinity : Infinity;
  groups.forEach((g, gi) => {
    const open = groupOpen.get(g.key) ?? gi < 2;
    const head = h('button', { type: 'button', class: 'g-head', 'aria-expanded': String(open), title: g.items[0].detail.type ?? '' },
      h('span', { class: 'caret', 'aria-hidden': 'true' }), h('span', { class: 'g-title' }, g.title), h('span', { class: 'g-count' }, String(g.items.length)));
    head.addEventListener('click', () => { groupOpen.set(g.key, !open); renderDetail(); });
    const sec = h('section', { class: 'group' }, head);
    if (g.subtitle) sec.append(h('div', { class: 'g-sub' }, g.subtitle));
    if (open) {
      const ul = h('ul', { class: 'occs' });
      g.items.forEach((it) => {
        const ms = it.time && start ? Date.parse(it.time) - Date.parse(start) : NaN;
        const expanded = traceOpen.has(it.id);
        const main = h('button', { type: 'button', class: 'occ-main', title: it.nodeId ? 'Jump to this step' : 'Not tied to a step: show details' },
          h('span', { class: 'occ-top' }, h('span', { class: 'occ-label' }, it.label), h('span', { class: 'occ-outcome', 'data-outcome': it.outcome }, outcomeWords(it.outcome)),
            ...(Number.isFinite(ms) ? [h('span', { class: 'tm' }, fmtOffset(ms))] : [])),
          h('span', { class: 'occ-msg' }, groupBy === 'type' ? firstLine(it.detail.message) : shortType(it.detail.type) || it.kind));
        main.addEventListener('click', () => jumpToFailure(it));
        const more = h('button', { type: 'button', class: 'occ-more', 'aria-expanded': String(expanded), 'aria-label': `${expanded ? 'Hide' : 'Show'} details of ${it.label} failure` }, h('span', { class: 'caret', 'aria-hidden': 'true' }));
        more.addEventListener('click', () => { expanded ? traceOpen.delete(it.id) : traceOpen.add(it.id); renderDetail(); });
        const li = h('li', { class: it.eventId > nowEvent ? 'occ future' : 'occ' }, h('div', { class: 'occ-row' }, main, more));
        if (expanded) li.append(failureBlock(it));
        ul.append(li);
      });
      sec.append(ul);
    }
    parts.push(sec);
  });
  el.detail.replaceChildren(...parts);
}

/** Clickable list of the run's steps; the current moment is highlighted and the rest are dimmed. */
function timelineList(): HTMLElement {
  const steps = scrubber.steps, p = scrubber.p;
  const lo = Math.max(0, Math.min(p - 1 - 100, steps.length - 300)), hi = Math.min(steps.length, lo + 300);
  const ul = h('ul', { class: 'timeline' });
  for (let i = lo; i < hi; i++) {
    const st = steps[i];
    const li = h('li', { 'data-kind': st.kind, class: i + 1 === p ? 'cur' : i + 1 > p ? 'future' : '' },
      h('span', { class: 'tm' }, fmtOffset(st.ms)), h('span', { class: 'wh' }, `${st.label} ${st.words}`));
    li.addEventListener('click', () => { scrubber.pause(); scrubber.goto(i + 1, true); });
    ul.append(li);
  }
  queueMicrotask(() => ul.querySelector('.cur')?.scrollIntoView({ block: 'nearest' }));
  return ul;
}

// ---------- wiring ----------
el.tabDetails.addEventListener('click', () => setTab('details'));
el.tabFailures.addEventListener('click', () => setTab('failures'));
for (const t of [el.tabDetails, el.tabFailures]) t.addEventListener('keydown', (e) => {
  const k = (e as KeyboardEvent).key;
  if (k !== 'ArrowLeft' && k !== 'ArrowRight') return;
  e.preventDefault(); const next = tab === 'details' ? 'failures' : 'details'; setTab(next); (next === 'details' ? el.tabDetails : el.tabFailures).focus();
});
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
