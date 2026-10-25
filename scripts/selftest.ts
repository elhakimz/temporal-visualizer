import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildGraph, canon, decodePayloads } from '../src/core/history';
import { layoutGraph } from '../src/core/layout';
import { NO_FILTER, applyFilter, failureCount, isUnfiltered } from '../src/core/filter';
import { diffGraphs, isEmpty, isStructural, summarize } from '../src/core/diff';

const sample = JSON.parse(readFileSync(new URL('../src/sample-history.json', import.meta.url), 'utf8'));
const g = buildGraph(sample.history.events);
const label = (id: string) => g.nodes.find((n) => n.id === id)!.label;
const edges = g.edges.map((e) => `${label(e.from)} -> ${label(e.to)}`);
console.log(edges.join('\n'));

assert.equal(canon('EVENT_TYPE_TIMER_FIRED'), 'TIMER_FIRED');
assert.equal(canon('TimerFired'), 'TIMER_FIRED');
assert.equal(canon('Running'), 'RUNNING');
assert.equal(canon('WORKFLOW_EXECUTION_STATUS_TIMED_OUT'), 'TIMED_OUT');

// sequential, then fork
assert.ok(edges.includes('OrderWorkflow -> ValidateOrder'));
assert.ok(edges.includes('ValidateOrder -> ChargePayment'));
assert.ok(edges.includes('ValidateOrder -> ReserveInventory'));
// join: local activity waits for both branches and the signal
for (const p of ['ChargePayment', 'ReserveInventory', 'managerApproval']) assert.ok(edges.includes(`${p} -> ComputeShippingLabel`), p);
// same-task command after a local activity depends on it
assert.ok(edges.includes('ComputeShippingLabel -> ShipOrder'));
assert.ok(edges.includes('ShipOrder -> Sleep 5s'));
assert.ok(edges.includes('Sleep 5s -> NotifyCustomer'));
assert.ok(edges.includes('NotifyCustomer -> Failed'));
// no transitive clutter
assert.ok(!edges.includes('ValidateOrder -> ComputeShippingLabel'));

const ship = g.nodes.find((n) => n.label === 'ShipOrder')!;
assert.equal(ship.state, 'failed');
assert.match(ship.failure!, /CarrierUnavailable: carrier API 503/);
assert.equal(g.status, 'FAILED');
assert.equal(g.nodes[0].input, JSON.stringify({ orderId: 'A-1042', total: 129.9 }, null, 2));
assert.equal(decodePayloads({ payloads: [] }), undefined);

// live view: truncate before ShipOrder finished, with a pending retry from describe
const cut = sample.history.events.findIndex((e: any) => e.eventType.endsWith('ACTIVITY_TASK_FAILED'));
const live = buildGraph(sample.history.events.slice(0, cut), {
  pendingActivities: [{ activityId: '4', state: 'PENDING_ACTIVITY_STATE_SCHEDULED', attempt: 2, maximumAttempts: 3 }],
});
const liveShip = live.nodes.find((n) => n.label === 'ShipOrder')!;
assert.equal(liveShip.state, 'retrying');
assert.equal(live.status, 'RUNNING');
assert.ok(!live.nodes.some((n) => n.kind === 'end'));

// Alternative JSON flavour: short enum names from the UI API
const short = JSON.parse(JSON.stringify(sample.history.events).replaceAll('EVENT_TYPE_', '').replace(/"([A-Z_]+)"/g, (m: string, s: string) =>
  /^(WORKFLOW|ACTIVITY|TIMER|MARKER|START_CHILD|CHILD)_/.test(s) ? `"${s.toLowerCase().split('_').map((x) => x[0].toUpperCase() + x.slice(1)).join('')}"` : m));
assert.equal(buildGraph(short).edges.length, g.edges.length);

// diffs between successive snapshots of a running workflow
const evs = sample.history.events;
const at = (n: number, pa?: any[]) => buildGraph(evs.slice(0, n), { pendingActivities: pa });
assert.ok(isEmpty(diffGraphs(at(20), at(20))));
const shipSched = evs.findIndex((e: any) => JSON.stringify(e).includes('ShipOrder') && e.eventType.endsWith('ACTIVITY_TASK_SCHEDULED'));
const dAdd = diffGraphs(at(shipSched), at(shipSched + 1));
assert.ok(isStructural(dAdd) && dAdd.addedNodes.some((n) => n.label === 'ShipOrder'), 'new step appears as an added node');
assert.ok(dAdd.addedEdges.some((e) => e.to.startsWith('act-')));
const dStart = diffGraphs(at(shipSched + 1), at(shipSched + 2));           // ActivityTaskStarted
assert.ok(!isStructural(dStart) && dStart.changedNodes[0].next.state === 'running', 'state change is not structural');
assert.deepEqual(summarize(dStart), ['ShipOrder: scheduled → running']);
const dRetry = diffGraphs(at(shipSched + 2, [{ activityId: '4', state: 'PENDING_ACTIVITY_STATE_STARTED', attempt: 1 }]),
  at(shipSched + 2, [{ activityId: '4', state: 'PENDING_ACTIVITY_STATE_SCHEDULED', attempt: 2, maximumAttempts: 3 }]));
assert.deepEqual(summarize(dRetry), ['ShipOrder: running → retrying']);
const dEnd = diffGraphs(at(evs.length - 1), at(evs.length));
assert.equal(dEnd.status?.to, 'FAILED');
assert.ok(dEnd.addedNodes.some((n) => n.kind === 'end'));

// list filters
const NOW = Date.parse('2026-10-25T15:00:00');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const wf = (id: string, status: string, startMin: number, parentWorkflowId?: string) =>
  ({ workflowId: id, runId: 'r', type: 'T', status, startTime: ago(startMin), parentWorkflowId });
const list = [wf('run', 'RUNNING', 10), wf('fail', 'FAILED', 200), wf('late', 'TIMED_OUT', 30), wf('kid', 'FAILED', 20, 'run'), wf('old', 'COMPLETED', 3000), wf('term', 'TERMINATED', 5)];
const ids = (f: any) => applyFilter(list, { ...NO_FILTER, ...f }, NOW).map((w) => w.workflowId).join(',');
assert.ok(isUnfiltered(NO_FILTER));
assert.equal(ids({}), 'run,fail,late,kid,old,term');
assert.equal(ids({ status: 'failures' }), 'fail,late,kid');          // failed + timed out, not terminated
assert.equal(ids({ status: 'running' }), 'run');
assert.equal(ids({ parent: true }), 'run,fail,late,old,term');        // child workflows hidden
assert.equal(ids({ time: 'hour' }), 'run,late,kid,term');
assert.equal(ids({ time: 'today' }), 'run,fail,late,kid,term');       // started after local midnight (15:00 now)
assert.equal(ids({ status: 'failures', parent: true, time: 'hour' }), 'late');
assert.equal(failureCount(list, NO_FILTER, NOW), 3);
assert.equal(failureCount(list, { ...NO_FILTER, parent: true }, NOW), 2);   // badge follows the other filters
assert.equal(failureCount(list, { ...NO_FILTER, status: 'running' }, NOW), 3); // and ignores the status chip itself

const pos = layoutGraph(g);
assert.equal(pos.size, g.nodes.length);
for (const [id, p] of pos) console.log(id.padEnd(22), String(Math.round(p.x)).padStart(5), String(Math.round(p.y)).padStart(5), 'h', p.h);
console.log('ok:', g.nodes.length, 'nodes,', g.edges.length, 'edges');
