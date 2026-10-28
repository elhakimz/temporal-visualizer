import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildGraph, canon, decodePayloads } from '../src/core/history';
import { layoutGraph } from '../src/core/layout';
import { classifyFrame, failureText, groupFailures, groupsText, normalizeMessage, parseFailure, shortType } from '../src/core/failure';
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

// ---- failure triage ----
const fx = JSON.parse(readFileSync(new URL('./fixtures/failing-history.json', import.meta.url), 'utf8')).history.events;
const fg = buildGraph(fx);
const f = fg.failures.filter((x) => !x.duplicateOf);
const dup = fg.failures.filter((x) => x.duplicateOf);
assert.equal(dup.length, 1); assert.equal(dup[0].nodeId, 'end'); assert.equal(dup[0].kind, 'workflow');
assert.equal(f.find((x) => x.eventId === 21)!.id, dup[0].duplicateOf);
const lab = (i: number) => `${f[i].label}/${f[i].kind}/${f[i].outcome}`;
console.log(f.map((x, i) => `  ${i}: ${lab(i)} #${x.eventId} ${x.detail.summary.slice(0, 70)}`).join('\n'));
assert.equal(f.length, 6, 'reserve, charge, email timeout, charge again, child, workflow task (the workflow failure is deduped)');
assert.deepEqual(f.map((x) => x.kind).sort(), ['activity', 'activity', 'activity', 'activity', 'child', 'workflowTask']);
assert.equal(groupFailures(fg.failures, 'type').reduce((n, g) => n + g.items.length, 0), 6, 'the wrapping workflow failure is not counted twice');
assert.equal(f.filter((x) => x.kind === 'activity' && x.outcome === 'failed').length, 3);
assert.equal(f.find((x) => x.label === 'SendConfirmationEmail')!.outcome, 'timedOut');
assert.equal(f.find((x) => x.label === 'SendConfirmationEmail')!.detail.type, 'Timeout (start to close)');
const wt = f.find((x) => x.kind === 'workflowTask')!;
assert.match(wt.detail.chain[0].info!, /non deterministic error/); assert.match(wt.detail.chain[0].stack!, /OrderWorkflowImpl/);
const funds = f.find((x) => x.label === 'ChargePayment')!;
assert.equal(funds.detail.type, 'com.acme.payments.InsufficientFundsException');
assert.deepEqual(funds.detail.chain.map((l) => l.kind), ['activity', 'application'], 'wrapper first, root cause last');
assert.match(funds.detail.chain[1].stack!, /LedgerClient\.debit/);
assert.match(funds.detail.chain[0].info!, /ChargePayment · id 1 · maximum attempts reached/);
const childF = f.find((x) => x.kind === 'child')!;
assert.equal(shortType(childF.detail.type), 'RefundRejectedException'); assert.equal(childF.detail.chain.length, 3);
const byType = groupFailures(f, 'type');
assert.equal(byType[0].title, 'InsufficientFundsException'); assert.equal(byType[0].items.length, 2);
assert.equal(byType.length, 5, 'funds, stock, timeout, refund rejected, non-determinism');
assert.equal(f.filter((x) => x.kind === 'activity' && x.outcome === 'failed').length + 1, 4);
assert.equal(groupFailures(f, 'message')[0].items.length, 2, 'messages that differ only in numbers group together');
assert.equal(normalizeMessage('Insufficient funds: balance 12.50 is below 129.90'), normalizeMessage('Insufficient funds: balance 3.20 is below 55.00'));
assert.equal(normalizeMessage('order 3f2b1c4e-1111-4222-8333-444455556666 failed'), 'order <id> failed');
assert.equal(classifyFrame('\tat java.base/jdk.internal.reflect.X.invoke(X.java:1)'), 'framework');
assert.equal(classifyFrame('\tat io.temporal.internal.worker.A.b(A.java:2)'), 'framework');
assert.equal(classifyFrame('\tat com.acme.payments.LedgerClient.debit(LedgerClient.java:112)'), 'app');
assert.equal(classifyFrame('Caused by: x'), 'text');
assert.equal(classifyFrame('    at Object.<anonymous> (/srv/app/node_modules/@temporalio/worker/lib/a.js:1:1)'), 'framework');
assert.match(failureText(funds), /Caused by: com\.acme\.payments\.InsufficientFundsException: Insufficient funds/);
assert.match(groupsText(byType, 'Failures'), /2 × InsufficientFundsException/);
// encoded (encrypted) failures are decoded; unknown shapes do not throw
const enc = Buffer.from(JSON.stringify({ message: 'secret', stack_trace: 'at x' })).toString('base64');
assert.equal(parseFailure({ message: 'Encoded failure', encodedAttributes: { data: enc }, applicationFailureInfo: { type: 'T' } })!.message, 'secret');
assert.equal(parseFailure(undefined), undefined); assert.equal(parseFailure({})!.summary, 'Failure');
// live: a failed attempt that is still being retried shows up, and one that later completed does not
const liveEvs = evs.slice(0, evs.findIndex((e: any) => e.eventType.endsWith('ACTIVITY_TASK_FAILED')) + 0);
const retrying = buildGraph(liveEvs, { pendingActivities: [{ activityId: '4', state: 'PENDING_ACTIVITY_STATE_SCHEDULED', attempt: 2, maximumAttempts: 3, lastFailure: { message: 'boom', applicationFailureInfo: { type: 'IOException' } } }] });
assert.equal(retrying.failures.length, 1); assert.equal(retrying.failures[0].outcome, 'retrying'); assert.equal(retrying.failures[0].detail.type, 'IOException');
assert.equal(buildGraph(evs.slice(0, evs.length - 3)).failures.filter((x) => x.outcome === 'retrying').length, 0);
console.log('failure triage ok');

const pos = layoutGraph(g);
assert.equal(pos.size, g.nodes.length);
for (const [id, p] of pos) console.log(id.padEnd(22), String(Math.round(p.x)).padStart(5), String(Math.round(p.y)).padStart(5), 'h', p.h);
console.log('ok:', g.nodes.length, 'nodes,', g.edges.length, 'edges');
