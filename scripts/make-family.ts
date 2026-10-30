// Generates scripts/fixtures/family.json: runs that point at each other, for parent/child and Continue-As-New navigation.
//   order-P-7000 (OrderWorkflow) starts pay-P-7000 (PaymentFlow, ok) and ship-P-7000 (ShipFlow, fails because its child
//   label-P-7000 (LabelFlow) fails);  poller-Q-8000 (PollerWorkflow) continues as new twice: run-q1 -> run-q2 -> run-q3.
import { writeFileSync } from 'node:fs';

const b64 = (v: unknown) => ({ payloads: [{ metadata: { encoding: Buffer.from('json/plain').toString('base64') }, data: Buffer.from(JSON.stringify(v)).toString('base64') }] });

function run(startIso: string) {
  let id = 0, clock = Date.parse(startIso);
  const events: any[] = [];
  const ev = (type: string, attrs: Record<string, unknown> = {}, dt = 40) => {
    clock += dt;
    events.push({ eventId: String(++id), eventTime: new Date(clock).toISOString(), eventType: `EVENT_TYPE_${type}`,
      [type.split('_').map((p, i) => (i === 0 ? p.toLowerCase() : p[0] + p.slice(1).toLowerCase())).join('') + 'EventAttributes']: attrs });
    return id;
  };
  const wft = () => {
    const s = ev('WORKFLOW_TASK_SCHEDULED'), st = ev('WORKFLOW_TASK_STARTED', { scheduledEventId: String(s) }, 5);
    return ev('WORKFLOW_TASK_COMPLETED', { scheduledEventId: String(s), startedEventId: String(st) }, 8);
  };
  const activity = (w: number, name: string, actId: string, outcome: 'ok' | { failure: unknown }, dt = 300) => {
    const s = ev('ACTIVITY_TASK_SCHEDULED', { activityId: actId, activityType: { name }, taskQueue: { name: 'Q' }, workflowTaskCompletedEventId: String(w), startToCloseTimeout: '10s', retryPolicy: { maximumAttempts: 1 } }, 3);
    const st = ev('ACTIVITY_TASK_STARTED', { scheduledEventId: String(s), attempt: 1 }, 20);
    if (outcome === 'ok') ev('ACTIVITY_TASK_COMPLETED', { scheduledEventId: String(s), startedEventId: String(st), result: b64('ok') }, dt);
    else ev('ACTIVITY_TASK_FAILED', { scheduledEventId: String(s), startedEventId: String(st), failure: outcome.failure }, dt);
    return s;
  };
  return { ev, wft, activity, events };
}
const app = (type: string, message: string, cause?: unknown) => ({ message, source: 'JavaSDK', stackTrace: `${type}: ${message}\n\tat com.acme.Demo.run(Demo.java:42)`, applicationFailureInfo: { type }, ...(cause ? { cause } : {}) });
const wrapChild = (name: string, wid: string, rid: string, cause: unknown) => ({ message: 'Child Workflow execution failed', source: 'JavaSDK', stackTrace: '', childWorkflowExecutionFailureInfo: { workflowType: { name }, workflowExecution: { workflowId: wid, runId: rid }, retryState: 'RETRY_STATE_NON_RETRYABLE_FAILURE' }, cause });

const runs: any[] = [];

// ---------- parent: starts two children ----------
const P = run('2026-10-25T11:00:00Z');
P.ev('WORKFLOW_EXECUTION_STARTED', { workflowType: { name: 'OrderWorkflow' }, taskQueue: { name: 'Q' }, input: b64({ orderId: 'P-7000' }), attempt: 1, firstExecutionRunId: 'run-p' }, 0);
let w = P.wft();
const payInit = P.ev('START_CHILD_WORKFLOW_EXECUTION_INITIATED', { namespace: 'default', workflowId: 'pay-P-7000', workflowType: { name: 'PaymentFlow' }, taskQueue: { name: 'Q' }, workflowTaskCompletedEventId: String(w), input: b64({ amount: 55 }) }, 3);
const shipInit = P.ev('START_CHILD_WORKFLOW_EXECUTION_INITIATED', { namespace: 'default', workflowId: 'ship-P-7000', workflowType: { name: 'ShipFlow' }, taskQueue: { name: 'Q' }, workflowTaskCompletedEventId: String(w), input: b64({ sku: 'SKU-77' }) }, 3);
P.ev('CHILD_WORKFLOW_EXECUTION_STARTED', { initiatedEventId: String(payInit), workflowExecution: { workflowId: 'pay-P-7000', runId: 'run-pay' } }, 10);
P.ev('CHILD_WORKFLOW_EXECUTION_STARTED', { initiatedEventId: String(shipInit), workflowExecution: { workflowId: 'ship-P-7000', runId: 'run-ship' } }, 4);
P.ev('CHILD_WORKFLOW_EXECUTION_COMPLETED', { initiatedEventId: String(payInit), workflowExecution: { workflowId: 'pay-P-7000', runId: 'run-pay' }, result: b64('paid') }, 700);
const printer = app('com.acme.label.PrinterOfflineException', 'Printer offline: label queue 3');
const labelFail = wrapChild('LabelFlow', 'label-P-7000', 'run-label', { message: 'Activity task failed', source: 'JavaSDK', stackTrace: '', activityFailureInfo: { activityType: { name: 'PrintLabel' }, activityId: '1', retryState: 'RETRY_STATE_MAXIMUM_ATTEMPTS_REACHED' }, cause: printer });
const shipFail = wrapChild('ShipFlow', 'ship-P-7000', 'run-ship', wrapChild('LabelFlow', 'label-P-7000', 'run-label', labelFail.cause));
P.ev('CHILD_WORKFLOW_EXECUTION_FAILED', { initiatedEventId: String(shipInit), workflowExecution: { workflowId: 'ship-P-7000', runId: 'run-ship' }, failure: shipFail }, 900);
w = P.wft();
P.ev('WORKFLOW_EXECUTION_FAILED', { workflowTaskCompletedEventId: String(w), failure: shipFail }, 4);
runs.push({ workflowId: 'order-P-7000', runId: 'run-p', type: 'OrderWorkflow', status: 'Failed', startMinsAgo: 40, events: P.events });

// ---------- child 1: payment ----------
const parentLink = (wid: string, rid: string, initiated: number) => ({ parentWorkflowExecution: { workflowId: wid, runId: rid }, parentWorkflowNamespace: 'default', parentInitiatedEventId: String(initiated) });
const C1 = run('2026-10-25T11:00:00.080Z');
C1.ev('WORKFLOW_EXECUTION_STARTED', { workflowType: { name: 'PaymentFlow' }, taskQueue: { name: 'Q' }, ...parentLink('order-P-7000', 'run-p', payInit), attempt: 1, firstExecutionRunId: 'run-pay' }, 0);
w = C1.wft(); C1.activity(w, 'AuthorizeCard', '1', 'ok', 500);
w = C1.wft(); C1.ev('WORKFLOW_EXECUTION_COMPLETED', { workflowTaskCompletedEventId: String(w), result: b64('paid') }, 4);
runs.push({ workflowId: 'pay-P-7000', runId: 'run-pay', type: 'PaymentFlow', status: 'Completed', startMinsAgo: 40, parent: { workflowId: 'order-P-7000', runId: 'run-p' }, events: C1.events });

// ---------- child 2: shipping, which starts a grandchild ----------
const C2 = run('2026-10-25T11:00:00.090Z');
C2.ev('WORKFLOW_EXECUTION_STARTED', { workflowType: { name: 'ShipFlow' }, taskQueue: { name: 'Q' }, ...parentLink('order-P-7000', 'run-p', shipInit), attempt: 1, firstExecutionRunId: 'run-ship' }, 0);
w = C2.wft(); C2.activity(w, 'PickItems', '1', 'ok', 350);
w = C2.wft();
const labelInit = C2.ev('START_CHILD_WORKFLOW_EXECUTION_INITIATED', { namespace: 'default', workflowId: 'label-P-7000', workflowType: { name: 'LabelFlow' }, taskQueue: { name: 'Q' }, workflowTaskCompletedEventId: String(w) }, 3);
C2.ev('CHILD_WORKFLOW_EXECUTION_STARTED', { initiatedEventId: String(labelInit), workflowExecution: { workflowId: 'label-P-7000', runId: 'run-label' } }, 8);
C2.ev('CHILD_WORKFLOW_EXECUTION_FAILED', { initiatedEventId: String(labelInit), workflowExecution: { workflowId: 'label-P-7000', runId: 'run-label' }, failure: labelFail }, 300);
w = C2.wft(); C2.ev('WORKFLOW_EXECUTION_FAILED', { workflowTaskCompletedEventId: String(w), failure: wrapChild('LabelFlow', 'label-P-7000', 'run-label', labelFail.cause) }, 4);
runs.push({ workflowId: 'ship-P-7000', runId: 'run-ship', type: 'ShipFlow', status: 'Failed', startMinsAgo: 40, parent: { workflowId: 'order-P-7000', runId: 'run-p' }, events: C2.events });

// ---------- grandchild ----------
const C3 = run('2026-10-25T11:00:00.500Z');
C3.ev('WORKFLOW_EXECUTION_STARTED', { workflowType: { name: 'LabelFlow' }, taskQueue: { name: 'Q' }, ...parentLink('ship-P-7000', 'run-ship', labelInit), attempt: 1, firstExecutionRunId: 'run-label' }, 0);
w = C3.wft(); C3.activity(w, 'PrintLabel', '1', { failure: { message: 'Activity task failed', source: 'JavaSDK', stackTrace: '', activityFailureInfo: { activityType: { name: 'PrintLabel' }, activityId: '1', retryState: 'RETRY_STATE_MAXIMUM_ATTEMPTS_REACHED' }, cause: printer } }, 200);
w = C3.wft(); C3.ev('WORKFLOW_EXECUTION_FAILED', { workflowTaskCompletedEventId: String(w), failure: { message: 'Activity task failed', source: 'JavaSDK', stackTrace: '', activityFailureInfo: { activityType: { name: 'PrintLabel' }, activityId: '1' }, cause: printer } }, 4);
runs.push({ workflowId: 'label-P-7000', runId: 'run-label', type: 'LabelFlow', status: 'Failed', startMinsAgo: 40, parent: { workflowId: 'ship-P-7000', runId: 'run-ship' }, events: C3.events });

// ---------- continue-as-new chain ----------
const chain = [['run-q1', null, 'run-q2', 35], ['run-q2', 'run-q1', 'run-q3', 30], ['run-q3', 'run-q2', null, 25]] as const;
for (const [rid, prev, next, ago] of chain) {
  const Q = run(`2026-10-25T11:${String(60 - ago).padStart(2, '0')}:00Z`);
  Q.ev('WORKFLOW_EXECUTION_STARTED', { workflowType: { name: 'PollerWorkflow' }, taskQueue: { name: 'Q' }, input: b64({ cursor: rid }), attempt: 1, firstExecutionRunId: 'run-q1',
    ...(prev ? { continuedExecutionRunId: prev, initiator: 'CONTINUE_AS_NEW_INITIATOR_WORKFLOW' } : {}) }, 0);
  w = Q.wft(); Q.activity(w, 'PollQueue', '1', 'ok', 250);
  w = Q.wft();
  if (next) Q.ev('WORKFLOW_EXECUTION_CONTINUED_AS_NEW', { newExecutionRunId: next, workflowType: { name: 'PollerWorkflow' }, taskQueue: { name: 'Q' }, workflowTaskCompletedEventId: String(w), initiator: 'CONTINUE_AS_NEW_INITIATOR_WORKFLOW' }, 4);
  else Q.ev('WORKFLOW_EXECUTION_COMPLETED', { workflowTaskCompletedEventId: String(w), result: b64('done') }, 4);
  runs.push({ workflowId: 'poller-Q-8000', runId: rid, type: 'PollerWorkflow', status: next ? 'ContinuedAsNew' : 'Completed', startMinsAgo: ago, events: Q.events });
}

writeFileSync(new URL('./fixtures/family.json', import.meta.url), JSON.stringify({ runs, latest: { 'poller-Q-8000': 'run-q3' } }, null, 2));
console.log('wrote', runs.length, 'runs,', runs.reduce((n, r) => n + r.events.length, 0), 'events');
