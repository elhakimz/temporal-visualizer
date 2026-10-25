// Generates src/sample-history.json: a Java-style order workflow with a fork/join,
// a signal, a failing activity that retries, a local activity and a child workflow.
import { writeFileSync } from 'node:fs';

const b64 = (v: unknown) => ({ payloads: [{ metadata: { encoding: Buffer.from('json/plain').toString('base64') }, data: Buffer.from(JSON.stringify(v)).toString('base64') }] });
let id = 0;
let clock = Date.parse('2026-10-25T09:00:00Z');
const events: any[] = [];
const ev = (type: string, attrs: Record<string, unknown> = {}, dt = 40) => {
  clock += dt;
  const e = { eventId: String(++id), eventTime: new Date(clock).toISOString(), eventType: type,
    [type.replace(/^EVENT_TYPE_/, '').split('_').map((p, i) => i === 0 ? p.toLowerCase() : p[0] + p.slice(1).toLowerCase()).join('') + 'EventAttributes']: attrs };
  events.push(e);
  return id;
};
const ET = (s: string) => `EVENT_TYPE_${s}`;
const wft = () => {
  const s = ev(ET('WORKFLOW_TASK_SCHEDULED'));
  const st = ev(ET('WORKFLOW_TASK_STARTED'), { scheduledEventId: String(s) }, 5);
  return ev(ET('WORKFLOW_TASK_COMPLETED'), { scheduledEventId: String(s), startedEventId: String(st) }, 8);
};
const act = (w: number, name: string, actId: string, extra: Record<string, unknown> = {}) =>
  ev(ET('ACTIVITY_TASK_SCHEDULED'), { activityId: actId, activityType: { name }, taskQueue: { name: 'ORDERS' },
    workflowTaskCompletedEventId: String(w), startToCloseTimeout: '10s', retryPolicy: { maximumAttempts: 3 }, ...extra }, 3);
const started = (s: number, attempt = 1) => ev(ET('ACTIVITY_TASK_STARTED'), { scheduledEventId: String(s), attempt }, 20);
const done = (s: number, st: number, result: unknown, dt = 400) =>
  ev(ET('ACTIVITY_TASK_COMPLETED'), { scheduledEventId: String(s), startedEventId: String(st), result: b64(result) }, dt);

ev(ET('WORKFLOW_EXECUTION_STARTED'), { workflowType: { name: 'OrderWorkflow' }, taskQueue: { name: 'ORDERS' }, input: b64({ orderId: 'A-1042', total: 129.9 }), attempt: 1 }, 0);

let w = wft();
const validate = act(w, 'ValidateOrder', '1', { input: b64({ orderId: 'A-1042' }) });
done(validate, started(validate), { ok: true });

w = wft();
const charge = act(w, 'ChargePayment', '2');
const reserve = act(w, 'ReserveInventory', '3');
const reserveStart = started(reserve);
const chargeStart = started(charge);
done(reserve, reserveStart, { sku: 'SKU-77', qty: 2 }, 300);
wft();                                   // task that issues no commands: still waiting for payment
done(charge, chargeStart, { txn: 'tx_9981' }, 700);

w = wft();
const sig = ev(ET('WORKFLOW_EXECUTION_SIGNALED'), { signalName: 'managerApproval', input: b64({ approvedBy: 'dewi' }) }, 200);
w = wft();
ev(ET('MARKER_RECORDED'), { markerName: 'LocalActivity', workflowTaskCompletedEventId: String(w),
  details: { data: b64({ activityId: 'l1', type: 'ComputeShippingLabel' }) } }, 2);
const ship = act(w, 'ShipOrder', '4');
const s1 = started(ship, 1);
ev(ET('ACTIVITY_TASK_FAILED'), { scheduledEventId: String(ship), startedEventId: String(s1),
  failure: { message: 'activity failed', cause: { message: 'carrier API 503', applicationFailureInfo: { type: 'CarrierUnavailable' } } }, retryState: 'RETRY_STATE_MAXIMUM_ATTEMPTS_REACHED' }, 900);
w = wft();
const timer = ev(ET('TIMER_STARTED'), { timerId: '5', startToFireTimeout: '5s', workflowTaskCompletedEventId: String(w) }, 3);
ev(ET('TIMER_FIRED'), { timerId: '5', startedEventId: String(timer) }, 5000);
w = wft();
const child = ev(ET('START_CHILD_WORKFLOW_EXECUTION_INITIATED'), { workflowId: 'notify-A-1042', workflowType: { name: 'NotifyCustomer' },
  taskQueue: { name: 'ORDERS' }, workflowTaskCompletedEventId: String(w), input: b64({ channel: 'email' }) }, 3);
ev(ET('CHILD_WORKFLOW_EXECUTION_STARTED'), { initiatedEventId: String(child), workflowExecution: { workflowId: 'notify-A-1042', runId: 'c0ffee00-1111-4222-8333-444455556666' } }, 10);
ev(ET('CHILD_WORKFLOW_EXECUTION_COMPLETED'), { initiatedEventId: String(child), result: b64('sent') }, 600);
w = wft();
ev(ET('WORKFLOW_EXECUTION_FAILED'), { workflowTaskCompletedEventId: String(w),
  failure: { message: 'Activity failure', cause: { message: 'carrier API 503', applicationFailureInfo: { type: 'CarrierUnavailable' } } } }, 4);
void sig;

writeFileSync(new URL('../src/sample-history.json', import.meta.url), JSON.stringify({ history: { events } }, null, 2));
console.log(`wrote ${events.length} events`);
