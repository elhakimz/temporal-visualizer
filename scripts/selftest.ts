import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildGraph, canon, decodePayloads } from '../src/core/history';
import { layoutGraph } from '../src/core/layout';
import { buildSteps, eventWords, fmtOffset, graphAtStep, nearestStep, playDelay, stepPositions } from '../src/core/timeline';
import { DEFAULT_WIDTH, MIN_WIDTH, clampWidth, maxWidth } from '../src/core/sidebar-size';
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

// sidebar width limits
assert.equal(maxWidth(1500), 675);                      // 45 % of the window
assert.equal(clampWidth(900, 1500), 675);               // dragged too far
assert.equal(clampWidth(100, 1500), MIN_WIDTH);         // dragged too small
assert.equal(clampWidth(DEFAULT_WIDTH, 1500), DEFAULT_WIDTH);
assert.equal(clampWidth(400, 500), MIN_WIDTH);          // tiny window: the floor wins

// replay scrubber timeline
const steps = buildSteps(evs, g);
assert.ok(steps.length > 10 && steps.length < evs.length, 'workflow-task bookkeeping is not a step');
assert.ok(!steps.some((st) => ['WORKFLOW_TASK_SCHEDULED', 'WORKFLOW_TASK_STARTED', 'WORKFLOW_TASK_COMPLETED'].includes(st.type)));
assert.equal(steps[0].type, 'WORKFLOW_EXECUTION_STARTED');
assert.equal(steps[steps.length - 1].type, 'WORKFLOW_EXECUTION_FAILED');
assert.ok(steps.every((st, i) => i === 0 || (st.ms >= steps[i - 1].ms && st.index > steps[i - 1].index)), 'time and order only move forward');
assert.equal(eventWords('EVENT_TYPE_ACTIVITY_TASK_TIMED_OUT'), 'timed out');
assert.equal(eventWords('TIMER_FIRED'), 'timer fired');
assert.deepEqual([steps[0].label, steps[0].words], ['Workflow', 'started']);
assert.deepEqual([steps[steps.length - 1].label, steps[steps.length - 1].words], ['Workflow', 'failed']);
assert.equal(graphAtStep(evs, steps, 1).nodes.length, 1, 'step 1 shows only the start');
assert.equal(graphAtStep(evs, steps, 0).nodes.length, 0);
let prevNodes = 0;
for (let k = 1; k <= steps.length; k++) { const n = graphAtStep(evs, steps, k).nodes.length; assert.ok(n >= prevNodes, 'nodes never disappear going forward'); prevNodes = n; }
const lastG = graphAtStep(evs, steps, steps.length);
assert.equal(lastG.nodes.length, g.nodes.length); assert.equal(lastG.edges.length, g.edges.length); assert.equal(lastG.status, 'FAILED');
const shipStep = steps.findIndex((st) => st.label === 'ShipOrder' && st.type === 'ACTIVITY_TASK_FAILED') + 1;
assert.equal(graphAtStep(evs, steps, shipStep).nodes.find((n) => n.label === 'ShipOrder')!.state, 'failed');
assert.equal(graphAtStep(evs, steps, shipStep - 1).nodes.find((n) => n.label === 'ShipOrder')!.state, 'running');
const even = stepPositions(steps, 'steps'), timed = stepPositions(steps, 'time');
assert.equal(even[0], 0); assert.equal(even[even.length - 1], 1); assert.equal(timed[timed.length - 1], 1);
assert.ok(timed.every((v, i) => i === 0 || v >= timed[i - 1]));
assert.equal(nearestStep(even, 0), 1); assert.equal(nearestStep(even, 1), steps.length); assert.equal(nearestStep(even, .5), Math.round(.5 * (steps.length - 1)) + 1);
assert.equal(nearestStep(timed, -5), 1); assert.equal(nearestStep(timed, 9), steps.length);
assert.equal(fmtOffset(420), '+420 ms'); assert.equal(fmtOffset(3410), '+3.41 s'); assert.equal(fmtOffset(125000), '+2 min 05 s');
assert.equal(playDelay(steps, 1, 'steps', 2), 325);
assert.ok(playDelay(steps, steps.findIndex((st) => st.label === 'Sleep 5s' && st.type === 'TIMER_FIRED'), 'time', 1) > 1000, 'a 5 s sleep takes visibly longer in time mode');
console.log('timeline ok:', steps.length, 'steps from', evs.length, 'events');

const pos = layoutGraph(g);
assert.equal(pos.size, g.nodes.length);
for (const [id, p] of pos) console.log(id.padEnd(22), String(Math.round(p.x)).padStart(5), String(Math.round(p.y)).padStart(5), 'h', p.h);
console.log('ok:', g.nodes.length, 'nodes,', g.edges.length, 'edges');
