// Minimal stand-in for the Temporal UI HTTP API (port 8233), for trying the visualizer
// without a server:  node scripts/mock-temporal-ui.mjs   (then TEMPORAL_UI=http://localhost:8234 npm run dev)
//
//   order-A-1042  a finished workflow (paged history)
//   order-B-2210  a workflow that keeps progressing: new events appear every ~0.7 s and
//                 GET .../history?waitNewEvent=true is held open until one arrives (long poll)
import http from 'node:http';
import { readFileSync } from 'node:fs';

const all = JSON.parse(readFileSync(new URL('../src/sample-history.json', import.meta.url), 'utf8')).history.events;
const failedIdx = all.findIndex((e) => e.eventType.endsWith('ACTIVITY_TASK_FAILED'));
const shipIdx = all.findIndex((e) => e.eventType.endsWith('ACTIVITY_TASK_SCHEDULED') && JSON.stringify(e).includes('ShipOrder'));

const live = { shown: Number(process.env.START_AT ?? 12), waiters: [] };
const stepMs = Number(process.env.STEP_MS ?? 700);
(function advance() {
  if (live.shown >= all.length) return;
  setTimeout(() => { live.shown++; live.waiters.splice(0).forEach((w) => w()); advance(); }, all[live.shown]?.eventType.endsWith('ACTIVITY_TASK_FAILED') ? 3000 : stepMs);
})();

const runs = {
  'order-A-1042': { runId: 'run-done', get status() { return 'Failed'; }, get events() { return all; } },
  'order-B-2210': {
    runId: 'run-live',
    get status() { return live.shown >= all.length ? 'Failed' : 'Running'; },
    get events() { return all.slice(0, live.shown); },
    get pending() {
      if (live.shown <= shipIdx || live.shown > failedIdx) return [];
      const retrying = live.shown >= failedIdx;
      return [{ activityId: '4', activityType: { name: 'ShipOrder' }, maximumAttempts: 3,
        state: retrying ? 'PENDING_ACTIVITY_STATE_SCHEDULED' : 'PENDING_ACTIVITY_STATE_STARTED', attempt: retrying ? 2 : 1,
        lastFailure: retrying ? { message: 'activity failed', cause: { message: 'carrier API 503', applicationFailureInfo: { type: 'CarrierUnavailable' } } } : undefined }];
    },
  },
};
// Extra rows for trying the list filters; they all open the finished sample history.
const mins = (m) => new Date(Date.now() - m * 60_000).toISOString();
const extra = [
  { id: 'order-D-4001', runId: 'run-d', status: 'TimedOut', start: mins(25) },
  { id: 'notify-A-1042', runId: 'run-n', status: 'Completed', start: mins(180), parent: 'order-A-1042' },
  { id: 'order-C-3300', runId: 'run-c', status: 'Completed', start: mins(60 * 30) },
  { id: 'order-E-5120', runId: 'run-e', status: 'Failed', start: mins(240), parent: undefined },
];
for (const x of extra) runs[x.id] = { runId: x.runId, status: x.status, events: all, start: x.start, parent: x.parent };
runs['order-A-1042'].start = mins(200);
runs['order-B-2210'].start = mins(8);
// SPAWN_MS=4000 starts a new workflow that often (it completes 5 s later), to try the list's live updates.
if (process.env.SPAWN_MS) {
  let n = 0;
  setInterval(() => {
    const id = `order-N-${String(++n).padStart(4, '0')}`;
    runs[id] = { runId: `run-n${n}`, status: 'Running', events: all.slice(0, 8), start: new Date().toISOString() };
    setTimeout(() => { runs[id].status = n % 2 ? 'Completed' : 'Failed'; }, 5000);
  }, Number(process.env.SPAWN_MS));
}
const failing = JSON.parse(readFileSync(new URL('./fixtures/failing-history.json', import.meta.url), 'utf8')).history.events;
runs['order-F-6001'] = { runId: 'run-f', status: 'Failed', events: failing, start: mins(15) };
// Runs that point at each other (parent/child, continue-as-new): see scripts/make-family.ts
const family = JSON.parse(readFileSync(new URL('./fixtures/family.json', import.meta.url), 'utf8'));
const famRuns = new Map(family.runs.map((r) => [`${r.workflowId}/${r.runId}`, { ...r, start: mins(r.startMinsAgo) }]));
const lookup = (wid, rid) => famRuns.get(`${wid}/${rid}`) ?? runs[wid];
const PAGE = 20;
const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const enc = (n) => Buffer.from(String(n)).toString('base64');
const dec = (t) => (t ? Number(Buffer.from(t, 'base64').toString()) : 0);

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  let m;
  if (p === '/api/v1/namespaces/default/workflows') {
    const rows = [...Object.entries(runs).map(([id, r]) => ({ id, r })), ...[...famRuns.values()].map((r) => ({ id: r.workflowId, r }))];
    return send(res, 200, { executions: rows.sort((a, b) => Date.parse(b.r.start ?? all[0].eventTime) - Date.parse(a.r.start ?? all[0].eventTime)).map(({ id, r }) => ({
      execution: { workflowId: id, runId: r.runId }, type: { name: r.type ?? 'OrderWorkflow' }, status: r.status,
      startTime: r.start ?? all[0].eventTime, taskQueue: 'ORDERS', historyLength: String(r.events.length),
      ...(r.parent ? { parentExecution: typeof r.parent === 'string' ? { workflowId: r.parent, runId: 'x' } : r.parent } : {}) })) });
  }
  // The Temporal UI's own events route (the live workflow deliberately lacks it)
  if ((m = p.match(/^\/api\/v1\/namespaces\/default\/workflows\/([^/]+)\/runs\/([^/]+)\/events$/))) {
    const r = lookup(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
    if (!r || r.runId === 'run-live') return send(res, 404, { message: 'route not available' });
    const start = dec(url.searchParams.get('nextPageToken'));
    const slice = r.events.slice(start, start + PAGE);
    return send(res, 200, { history: { events: slice }, nextPageToken: start + PAGE < r.events.length ? enc(start + PAGE) : '' });
  }
  // gRPC-gateway route with long polling
  if ((m = p.match(/^\/api\/v1\/namespaces\/default\/workflows\/([^/]+)\/history$/))) {
    const id = decodeURIComponent(m[1]);
    const r = lookup(id, url.searchParams.get('execution.runId') ?? '');
    if (!r) return send(res, 404, { message: 'not found' });
    const size = Number(url.searchParams.get('maximumPageSize')) || 500;
    const from = dec(url.searchParams.get('nextPageToken'));
    if (url.searchParams.get('waitNewEvent') === 'true' && id === 'order-B-2210' && from >= r.events.length && r.status === 'Running') {
      let gone = false;
      req.on('close', () => { gone = true; });
      await new Promise((resolve) => { live.waiters.push(resolve); setTimeout(resolve, 20000); });
      if (gone) return;
    }
    const events = r.events.slice(from, from + size);
    const next = from + events.length;
    const closed = r.status !== 'Running' && next >= r.events.length;
    return send(res, 200, { history: { events }, nextPageToken: closed ? '' : enc(next) });
  }
  // describe without a run id answers for the latest run of that workflow id
  if ((m = p.match(/^\/api\/v1\/namespaces\/default\/workflows\/([^/]+)$/))) {
    const wid = decodeURIComponent(m[1]);
    const rid = family.latest[wid] ?? runs[wid]?.runId;
    const r = rid && lookup(wid, rid);
    if (!r) return send(res, 404, { message: 'not found' });
    return send(res, 200, { workflowExecutionInfo: { execution: { workflowId: wid, runId: rid }, status: r.status }, pendingActivities: [] });
  }
  if ((m = p.match(/^\/api\/v1\/namespaces\/default\/workflows\/([^/]+)\/runs\/([^/]+)$/))) {
    const r = lookup(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
    if (!r) return send(res, 404, { message: 'not found' });
    return send(res, 200, { workflowExecutionInfo: { status: r.status }, pendingActivities: r.pending ?? [] });
  }
  send(res, 404, { message: `no route for ${p}` });
}).listen(Number(process.env.PORT ?? 8234), () => console.log('mock Temporal UI API on', process.env.PORT ?? 8234));
