// Generates scripts/fixtures/failing-history.json: an order workflow with many kinds of failure,
// used by the mock server and the tests (several failures of one type, a timeout, a failed child workflow,
// a non-determinism error, and a workflow failure that only wraps one of the activity failures).
import { writeFileSync } from 'node:fs';

const b64 = (v: unknown) => ({ payloads: [{ metadata: { encoding: Buffer.from('json/plain').toString('base64') }, data: Buffer.from(JSON.stringify(v)).toString('base64') }] });
let id = 0;
let clock = Date.parse('2026-10-25T10:00:00Z');
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
const act = (w: number, name: string, actId: string) =>
  ev('ACTIVITY_TASK_SCHEDULED', { activityId: actId, activityType: { name }, taskQueue: { name: 'ORDERS' }, workflowTaskCompletedEventId: String(w), startToCloseTimeout: '10s', retryPolicy: { maximumAttempts: 3 } }, 3);
const started = (s: number, attempt = 1) => ev('ACTIVITY_TASK_STARTED', { scheduledEventId: String(s), attempt }, 20);

const frames = (appFrames: string[]) => [
  ...appFrames.map((f) => `\tat ${f}`),
  '\tat java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(DirectMethodHandleAccessor.java:103)',
  '\tat java.base/java.lang.reflect.Method.invoke(Method.java:580)',
  '\tat io.temporal.internal.activity.RootActivityInboundCallsInterceptor.execute(RootActivityInboundCallsInterceptor.java:41)',
  '\tat io.temporal.internal.worker.ActivityTaskHandlerImpl$POJOActivityImplementation.execute(ActivityTaskHandlerImpl.java:272)',
  '\tat io.temporal.internal.worker.ActivityWorker$TaskHandlerImpl.handle(ActivityWorker.java:214)',
].join('\n');
const app = (type: string, message: string, stack: string, cause?: unknown) =>
  ({ message, source: 'JavaSDK', stackTrace: `${type}: ${message}\n${stack}`, applicationFailureInfo: { type, nonRetryable: false }, ...(cause ? { cause } : {}) });
const activityWrap = (name: string, actId: string, sched: number, retryState: string, cause: unknown) =>
  ({ message: 'Activity task failed', source: 'JavaSDK', stackTrace: '', activityFailureInfo: { activityType: { name }, activityId: actId, scheduledEventId: String(sched), retryState }, cause });

const fundsStack = (line: number) => frames([`com.acme.payments.LedgerClient.debit(LedgerClient.java:${line})`, 'com.acme.payments.ChargeActivityImpl.charge(ChargeActivityImpl.java:57)']);
const funds1 = app('com.acme.payments.InsufficientFundsException', 'Insufficient funds: balance 12.50 is below 129.90', fundsStack(112));
const funds2 = app('com.acme.payments.InsufficientFundsException', 'Insufficient funds: balance 3.20 is below 55.00', fundsStack(112));
const stock = app('com.acme.inventory.OutOfStockException', 'Out of stock: SKU-77 (requested 2, available 0)',
  frames(['com.acme.inventory.StockRepository.reserve(StockRepository.java:88)', 'com.acme.inventory.ReserveActivityImpl.reserve(ReserveActivityImpl.java:34)']));

ev('WORKFLOW_EXECUTION_STARTED', { workflowType: { name: 'OrderWorkflow' }, taskQueue: { name: 'ORDERS' }, input: b64({ orderId: 'F-6001', total: 129.9 }), attempt: 1 }, 0);

let w = wft();
const charge = act(w, 'ChargePayment', '1'), reserve = act(w, 'ReserveInventory', '2'), email = act(w, 'SendConfirmationEmail', '3');
const cs = started(charge), rs = started(reserve), es = started(email);
ev('ACTIVITY_TASK_FAILED', { scheduledEventId: String(reserve), startedEventId: String(rs), failure: activityWrap('ReserveInventory', '2', reserve, 'RETRY_STATE_NON_RETRYABLE_FAILURE', stock), retryState: 'RETRY_STATE_NON_RETRYABLE_FAILURE' }, 180);
ev('ACTIVITY_TASK_FAILED', { scheduledEventId: String(charge), startedEventId: String(cs), failure: activityWrap('ChargePayment', '1', charge, 'RETRY_STATE_MAXIMUM_ATTEMPTS_REACHED', funds1), retryState: 'RETRY_STATE_MAXIMUM_ATTEMPTS_REACHED' }, 220);
ev('ACTIVITY_TASK_TIMED_OUT', { scheduledEventId: String(email), startedEventId: String(es), failure: { message: 'activity timeout', source: 'Server', timeoutFailureInfo: { timeoutType: 'TIMEOUT_TYPE_START_TO_CLOSE' } }, retryState: 'RETRY_STATE_TIMEOUT' }, 9000);

w = wft();
const charge2 = act(w, 'ChargePayment', '4');
const child = ev('START_CHILD_WORKFLOW_EXECUTION_INITIATED', { workflowId: 'refund-F-6001', workflowType: { name: 'RefundFlow' }, taskQueue: { name: 'ORDERS' }, workflowTaskCompletedEventId: String(w), input: b64({ orderId: 'F-6001' }) }, 3);
ev('CHILD_WORKFLOW_EXECUTION_STARTED', { initiatedEventId: String(child), workflowExecution: { workflowId: 'refund-F-6001', runId: 'c0ffee00-1111-4222-8333-444455556666' } }, 10);
const c2s = started(charge2);
ev('ACTIVITY_TASK_FAILED', { scheduledEventId: String(charge2), startedEventId: String(c2s), failure: activityWrap('ChargePayment', '4', charge2, 'RETRY_STATE_MAXIMUM_ATTEMPTS_REACHED', funds2), retryState: 'RETRY_STATE_MAXIMUM_ATTEMPTS_REACHED' }, 400);
const refund = app('com.acme.refunds.RefundRejectedException', 'Refund rejected: account closed', frames(['com.acme.refunds.RefundService.issue(RefundService.java:71)', 'com.acme.refunds.RefundActivityImpl.refund(RefundActivityImpl.java:29)']));
ev('CHILD_WORKFLOW_EXECUTION_FAILED', { initiatedEventId: String(child), failure: { message: 'Child Workflow execution failed', source: 'JavaSDK', stackTrace: '', childWorkflowExecutionFailureInfo: { workflowType: { name: 'RefundFlow' }, workflowExecution: { workflowId: 'refund-F-6001', runId: 'c0ffee00-1111-4222-8333-444455556666' }, retryState: 'RETRY_STATE_NON_RETRYABLE_FAILURE' }, cause: activityWrap('RefundActivity', '1', 7, 'RETRY_STATE_NON_RETRYABLE_FAILURE', refund) } }, 300);

// a workflow task that fails (non-determinism), then succeeds on retry
const s = ev('WORKFLOW_TASK_SCHEDULED'), st = ev('WORKFLOW_TASK_STARTED', { scheduledEventId: String(s) }, 5);
ev('WORKFLOW_TASK_FAILED', { scheduledEventId: String(s), startedEventId: String(st), cause: 'WORKFLOW_TASK_FAILED_CAUSE_NON_DETERMINISTIC_ERROR',
  failure: { message: '[TMPRL1100] Nondeterminism: event 14 is ActivityTaskScheduled, but workflow code issued a different command', source: 'JavaSDK', stackTrace: ['io.temporal.worker.NonDeterministicException: [TMPRL1100] Nondeterminism', '\tat io.temporal.internal.statemachines.WorkflowStateMachines.handleCommandEvent(WorkflowStateMachines.java:407)', '\tat com.acme.orders.OrderWorkflowImpl.run(OrderWorkflowImpl.java:63)', '\tat io.temporal.internal.sync.WorkflowThreadContext.run(WorkflowThreadContext.java:92)'].join('\n'), applicationFailureInfo: { type: 'io.temporal.worker.NonDeterministicException' } } }, 6);
w = wft();

// the workflow failure only wraps the last charge failure, so triage lists it once
ev('WORKFLOW_EXECUTION_FAILED', { workflowTaskCompletedEventId: String(w), failure: activityWrap('ChargePayment', '4', charge2, 'RETRY_STATE_MAXIMUM_ATTEMPTS_REACHED', funds2) }, 4);

writeFileSync(new URL('./fixtures/failing-history.json', import.meta.url), JSON.stringify({ history: { events } }, null, 2));
console.log(`wrote ${events.length} events`);
