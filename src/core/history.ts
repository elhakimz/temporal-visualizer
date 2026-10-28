// Turns a Temporal workflow event history into a small dependency graph.
//
// History does not record which result a command depended on, so the edges are
// inferred: everything that resolved since the previous batch of commands
// (activity done, timer fired, child finished, signal received) is treated as
// a parent of the commands the next workflow task issued.  This is exact for
// sequential flows and for fork/join patterns (Async.function + Promise.get).

import { parseFailure, sameCause, synthFailure, type FailureItem, type FailureKind, type FailureOutcome } from './failure';
export type { FailureItem } from './failure';

export type NodeKind =
  | 'start' | 'activity' | 'localActivity' | 'timer' | 'child' | 'signal' | 'update' | 'end';

export type NodeState =
  | 'scheduled' | 'running' | 'retrying' | 'completed' | 'failed' | 'timedOut' | 'canceled';

export interface HistoryEvent {
  eventId: string | number;
  eventTime?: string;
  eventType: string;
  [key: string]: unknown;
}

export interface PendingActivity {
  activityId?: string;
  activityType?: { name?: string };
  state?: string;
  attempt?: number;
  maximumAttempts?: number;
  lastFailure?: unknown;
}

export interface EventRef { id: number; type: string; time?: string }

export interface VNode {
  id: string;
  kind: NodeKind;
  label: string;
  state: NodeState;
  attempt?: number;
  maxAttempts?: number;
  scheduledAt?: string;
  startedAt?: string;
  closedAt?: string;
  durationMs?: number;
  failure?: string;
  detail: Record<string, string>;
  input?: string;
  result?: string;
  events: EventRef[];
}

export interface VEdge { from: string; to: string }

export interface VGraph {
  nodes: VNode[];
  edges: VEdge[];
  workflowType: string;
  status: string;
  warnings: string[];
  /** Every failure in the run: failed and timed-out steps, steps that are retrying, workflow-task failures. */
  failures: FailureItem[];
}

/** "EVENT_TYPE_TIMER_FIRED", "TimerFired" and "TIMER_FIRED" all become "TIMER_FIRED". */
export function canon(value: unknown): string {
  return String(value ?? '')
    .replace(/^(EVENT_TYPE_|WORKFLOW_EXECUTION_STATUS_|PENDING_ACTIVITY_STATE_)/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase();
}

type Attrs = Record<string, any>;

function attrsOf(e: HistoryEvent): Attrs {
  for (const key of Object.keys(e)) {
    if (key.endsWith('EventAttributes')) return (e[key] as Attrs) ?? {};
  }
  return {};
}

const num = (v: unknown): number | undefined => (v == null || v === '' ? undefined : Number(v));
const uniq = <T,>(xs: T[]): T[] => [...new Set(xs)];

function b64ToText(data: string): string {
  const bin = atob(data);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Decodes a Temporal Payloads object (json/plain encoding) into readable text. */
export function decodePayloads(p: unknown, limit = 2000): string | undefined {
  const payloads = (p as Attrs | undefined)?.payloads;
  if (!Array.isArray(payloads) || payloads.length === 0) return undefined;
  const parts = payloads.map((pl: Attrs) => {
    if (!pl?.data) return 'null';
    try {
      const text = b64ToText(String(pl.data));
      try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
    } catch {
      return '(binary payload)';
    }
  });
  const out = parts.join('\n');
  return out.length > limit ? out.slice(0, limit) + ' …' : out;
}

/** Deepest cause of a Temporal Failure, with the application failure type when present. */
export function describeFailure(f: unknown): string | undefined {
  let cur = f as Attrs | undefined;
  if (!cur || typeof cur !== 'object') return undefined;
  let deepest = cur;
  while (cur?.cause) { cur = cur.cause as Attrs; deepest = cur; }
  const type = deepest.applicationFailureInfo?.type as string | undefined;
  const msg = (deepest.message as string | undefined) ?? (f as Attrs).message;
  if (!msg && !type) return undefined;
  return type && msg ? `${type}: ${msg}` : String(msg ?? type);
}

function ms(a?: string, b?: string): number | undefined {
  if (!a || !b) return undefined;
  const d = Date.parse(b) - Date.parse(a);
  return Number.isFinite(d) ? d : undefined;
}

function markerLabel(a: Attrs): { kind: 'local' | 'other'; name: string; failed?: string; raw?: unknown } {
  const name = String(a.markerName ?? '');
  if (name !== 'LocalActivity') return { kind: 'other', name };
  let label = 'Local activity';
  let failed: string | undefined;
  try {
    const raw = a.details?.data?.payloads?.[0]?.data;
    if (raw) {
      const data = JSON.parse(b64ToText(String(raw)));
      label = data.type ?? data.activityType ?? data.activityId ?? label;
    }
    if (a.failure) failed = describeFailure(a.failure);
  } catch { /* marker payload formats differ between SDK versions */ }
  return { kind: 'local', name: label, failed, raw: a.failure };
}

export function buildGraph(
  events: HistoryEvent[],
  opts: { pendingActivities?: PendingActivity[]; workflowStatus?: string } = {},
): VGraph {
  const nodes: VNode[] = [];
  const edges: VEdge[] = [];
  const warnings: string[] = [];
  const byId = new Map<string, VNode>();
  const bySched = new Map<number, VNode>();
  const byTimer = new Map<string, VNode>();
  const byInit = new Map<number, VNode>();
  const updateAccepted = new Map<number, VNode>();
  const failures: FailureItem[] = [];
  const retryCandidate = new Map<string, { failure: unknown; eventId: number; time?: string }>();
  const addFailure = (n: VNode | undefined, kind: FailureKind, eventId: number, time: string | undefined, raw: unknown,
    outcome: FailureOutcome, o: { label?: string; fallback?: string; fallbackType?: string; info?: string; idSuffix?: string } = {}) => {
    const detail = parseFailure(raw) ?? (o.fallback ? synthFailure(o.fallback, o.fallbackType) : undefined);
    if (!detail) return;
    if (o.info) detail.chain[0].info = [detail.chain[0].info, o.info].filter(Boolean).join(' · ');
    failures.push({ id: `${n?.id ?? 'wf'}:${eventId}${o.idSuffix ?? ''}`, nodeId: n?.id, label: o.label ?? n?.label ?? 'Workflow task', kind, outcome, eventId, time, detail });
  };

  let workflowType = '';
  let startNode: VNode | undefined;
  let pending: string[] = [];
  let frontier: string[] = [];
  let curParents: string[] = [];
  let lastBatch: number | undefined;
  let status = 'RUNNING';

  const isSource = (id: string) => {
    const k = byId.get(id)?.kind;
    return k === 'signal' || k === 'update';
  };
  const add = (n: VNode) => { nodes.push(n); byId.set(n.id, n); return n; };
  const ref = (n: VNode, e: HistoryEvent, id: number) =>
    n.events.push({ id, type: canon(e.eventType), time: e.eventTime });

  const takeParents = (): string[] => {
    let parents = uniq(pending);
    pending = [];
    if (!parents.some((p) => !isSource(p))) parents = uniq([...parents, ...frontier]);
    return parents;
  };
  const enterBatch = (taskCompletedId: number | undefined, fallbackKey: number) => {
    const key = taskCompletedId ?? -fallbackKey;
    if (key === lastBatch) return;
    lastBatch = key;
    curParents = takeParents();
    frontier = [];
  };
  const attach = (n: VNode) => {
    for (const p of curParents) edges.push({ from: p, to: n.id });
    frontier.push(n.id);
  };
  const resolve = (n: VNode) => pending.push(n.id);

  for (const e of events) {
    const id = Number(e.eventId);
    const type = canon(e.eventType);
    const a = attrsOf(e);
    const t = e.eventTime;

    switch (type) {
      case 'WORKFLOW_EXECUTION_STARTED': {
        workflowType = a.workflowType?.name ?? '';
        startNode = add({
          id: 'start', kind: 'start', label: workflowType || 'Workflow', state: 'completed',
          startedAt: t, closedAt: t, events: [], detail: {
            'Task queue': a.taskQueue?.name ?? '',
            ...(a.attempt && Number(a.attempt) > 1 ? { 'Run attempt': String(a.attempt) } : {}),
          },
          input: decodePayloads(a.input),
        });
        ref(startNode, e, id);
        frontier = [startNode.id];
        break;
      }

      case 'WORKFLOW_TASK_FAILED':
      case 'WORKFLOW_TASK_TIMED_OUT': {
        const why = describeFailure(a.failure) ?? (a.timeoutType ? `timeout (${canon(a.timeoutType)})` : '');
        warnings.push(`Workflow task ${type === 'WORKFLOW_TASK_FAILED' ? 'failed' : 'timed out'} at event ${id}${why ? `: ${why}` : ''}`);
        if (type === 'WORKFLOW_TASK_FAILED') {
          const cause = a.cause ? String(canon(a.cause)).replace(/^WORKFLOW_TASK_FAILED_CAUSE_/, '').toLowerCase().replaceAll('_', ' ') : '';
          addFailure(undefined, 'workflowTask', id, t, a.failure, 'failed', { label: 'Workflow task', fallback: cause ? `Workflow task failed: ${cause}` : 'Workflow task failed', info: cause ? `cause: ${cause}` : undefined });
        } else {
          addFailure(undefined, 'workflowTask', id, t, undefined, 'timedOut', { label: 'Workflow task', fallback: 'Workflow task timed out', fallbackType: `Timeout (${String(canon(a.timeoutType ?? '')).replace(/^TIMEOUT_TYPE_/, '').toLowerCase().replaceAll('_', ' ') || 'unknown'})` });
        }
        break;
      }

      // ---------- activities ----------
      case 'ACTIVITY_TASK_SCHEDULED': {
        enterBatch(num(a.workflowTaskCompletedEventId), id);
        const n = add({
          id: `act-${id}`, kind: 'activity', label: a.activityType?.name ?? 'Activity',
          state: 'scheduled', scheduledAt: t, events: [], detail: {
            'Activity ID': String(a.activityId ?? ''),
            'Task queue': a.taskQueue?.name ?? '',
            ...(a.startToCloseTimeout ? { 'Start-to-close': String(a.startToCloseTimeout) } : {}),
            ...(a.scheduleToCloseTimeout ? { 'Schedule-to-close': String(a.scheduleToCloseTimeout) } : {}),
            ...(a.retryPolicy?.maximumAttempts ? { 'Max attempts': String(a.retryPolicy.maximumAttempts) } : {}),
          },
          input: decodePayloads(a.input),
        });
        if (a.retryPolicy?.maximumAttempts) n.maxAttempts = Number(a.retryPolicy.maximumAttempts);
        ref(n, e, id);
        bySched.set(id, n);
        attach(n);
        break;
      }
      case 'ACTIVITY_TASK_STARTED': {
        const n = bySched.get(Number(a.scheduledEventId));
        if (!n) break;
        n.state = 'running';
        n.startedAt = t;
        n.attempt = num(a.attempt) ?? 1;
        const lf = describeFailure(a.lastFailure);
        if (lf) { n.failure = `Previous attempt: ${lf}`; retryCandidate.set(n.id, { failure: a.lastFailure, eventId: id, time: t }); }
        ref(n, e, id);
        break;
      }
      case 'ACTIVITY_TASK_COMPLETED':
      case 'ACTIVITY_TASK_FAILED':
      case 'ACTIVITY_TASK_TIMED_OUT':
      case 'ACTIVITY_TASK_CANCELED': {
        const n = bySched.get(Number(a.scheduledEventId));
        if (!n) break;
        n.state = type.endsWith('COMPLETED') ? 'completed' : type.endsWith('FAILED') ? 'failed'
          : type.endsWith('TIMED_OUT') ? 'timedOut' : 'canceled';
        n.closedAt = t;
        n.durationMs = ms(n.scheduledAt, t);
        if (type.endsWith('COMPLETED')) { n.result = decodePayloads(a.result); n.failure = undefined; }
        else {
          n.failure = describeFailure(a.failure) ?? n.failure;
          addFailure(n, 'activity', id, t, a.failure, type.endsWith('TIMED_OUT') ? 'timedOut' : 'failed', { fallback: type.endsWith('TIMED_OUT') ? 'Activity timed out' : undefined });
        }
        ref(n, e, id);
        resolve(n);
        break;
      }
      case 'ACTIVITY_TASK_CANCEL_REQUESTED': {
        const n = bySched.get(Number(a.scheduledEventId));
        if (n) ref(n, e, id);
        break;
      }

      // ---------- timers ----------
      case 'TIMER_STARTED': {
        enterBatch(num(a.workflowTaskCompletedEventId), id);
        const n = add({
          id: `timer-${id}`, kind: 'timer', label: `Sleep ${a.startToFireTimeout ?? ''}`.trim(),
          state: 'running', scheduledAt: t, startedAt: t, events: [],
          detail: { 'Timer ID': String(a.timerId ?? ''), Duration: String(a.startToFireTimeout ?? '') },
        });
        ref(n, e, id);
        byTimer.set(String(a.timerId), n);
        attach(n);
        break;
      }
      case 'TIMER_FIRED': {
        const n = byTimer.get(String(a.timerId));
        if (!n) break;
        n.state = 'completed'; n.closedAt = t; n.durationMs = ms(n.startedAt, t);
        ref(n, e, id);
        resolve(n);
        break;
      }
      case 'TIMER_CANCELED': {
        const n = byTimer.get(String(a.timerId));
        if (!n) break;
        n.state = 'canceled'; n.closedAt = t; n.durationMs = ms(n.startedAt, t);
        ref(n, e, id);
        break;
      }

      // ---------- child workflows ----------
      case 'START_CHILD_WORKFLOW_EXECUTION_INITIATED': {
        enterBatch(num(a.workflowTaskCompletedEventId), id);
        const n = add({
          id: `child-${id}`, kind: 'child', label: a.workflowType?.name ?? 'Child workflow',
          state: 'scheduled', scheduledAt: t, events: [],
          detail: { 'Workflow ID': String(a.workflowId ?? ''), 'Task queue': a.taskQueue?.name ?? '' },
          input: decodePayloads(a.input),
        });
        ref(n, e, id);
        byInit.set(id, n);
        attach(n);
        break;
      }
      case 'CHILD_WORKFLOW_EXECUTION_STARTED': {
        const n = byInit.get(Number(a.initiatedEventId));
        if (!n) break;
        n.state = 'running'; n.startedAt = t;
        if (a.workflowExecution?.runId) n.detail['Run ID'] = String(a.workflowExecution.runId);
        ref(n, e, id);
        break;
      }
      case 'START_CHILD_WORKFLOW_EXECUTION_FAILED': {
        const n = byInit.get(Number(a.initiatedEventId));
        if (!n) break;
        n.state = 'failed'; n.closedAt = t; n.failure = `Could not start: ${canon(a.cause)}`;
        addFailure(n, 'child', id, t, undefined, 'failed', { fallback: `Could not start child workflow: ${String(canon(a.cause)).replace(/^START_CHILD_WORKFLOW_EXECUTION_FAILED_CAUSE_/, '').toLowerCase().replaceAll('_', ' ')}` });
        ref(n, e, id);
        resolve(n);
        break;
      }
      case 'CHILD_WORKFLOW_EXECUTION_COMPLETED':
      case 'CHILD_WORKFLOW_EXECUTION_FAILED':
      case 'CHILD_WORKFLOW_EXECUTION_TIMED_OUT':
      case 'CHILD_WORKFLOW_EXECUTION_CANCELED':
      case 'CHILD_WORKFLOW_EXECUTION_TERMINATED': {
        const n = byInit.get(Number(a.initiatedEventId));
        if (!n) break;
        n.state = type.endsWith('COMPLETED') ? 'completed' : type.endsWith('FAILED') ? 'failed'
          : type.endsWith('TIMED_OUT') ? 'timedOut' : 'canceled';
        n.closedAt = t; n.durationMs = ms(n.scheduledAt, t);
        if (type.endsWith('COMPLETED')) n.result = decodePayloads(a.result);
        else {
          n.failure = describeFailure(a.failure);
          if (type.endsWith('FAILED') || type.endsWith('TIMED_OUT')) addFailure(n, 'child', id, t, a.failure, type.endsWith('TIMED_OUT') ? 'timedOut' : 'failed', { fallback: type.endsWith('TIMED_OUT') ? 'Child workflow timed out' : undefined });
        }
        ref(n, e, id);
        resolve(n);
        break;
      }

      // ---------- external input ----------
      case 'WORKFLOW_EXECUTION_SIGNALED': {
        const n = add({
          id: `sig-${id}`, kind: 'signal', label: String(a.signalName ?? 'Signal'),
          state: 'completed', scheduledAt: t, closedAt: t, events: [],
          detail: a.identity ? { Sender: String(a.identity) } : {},
          input: decodePayloads(a.input),
        });
        ref(n, e, id);
        resolve(n);
        break;
      }
      case 'WORKFLOW_EXECUTION_UPDATE_ACCEPTED': {
        const name = a.acceptedRequest?.input?.name ?? 'Update';
        const n = add({
          id: `upd-${id}`, kind: 'update', label: String(name), state: 'running',
          scheduledAt: t, events: [], detail: {},
          input: decodePayloads(a.acceptedRequest?.input?.args),
        });
        ref(n, e, id);
        updateAccepted.set(id, n);
        resolve(n);
        break;
      }
      case 'WORKFLOW_EXECUTION_UPDATE_COMPLETED': {
        const n = updateAccepted.get(Number(a.acceptedEventId));
        if (!n) break;
        const failed = a.outcome?.failure;
        n.state = failed ? 'failed' : 'completed'; n.closedAt = t;
        n.durationMs = ms(n.scheduledAt, t);
        if (failed) { n.failure = describeFailure(failed); addFailure(n, 'update', id, t, failed, 'failed'); } else n.result = decodePayloads(a.outcome?.success);
        ref(n, e, id);
        break;
      }

      // ---------- markers (Java: local activities) ----------
      case 'MARKER_RECORDED': {
        const m = markerLabel(a);
        if (m.kind !== 'local') break;
        enterBatch(num(a.workflowTaskCompletedEventId), id);
        const n = add({
          id: `local-${id}`, kind: 'localActivity', label: m.name,
          state: m.failed ? 'failed' : 'completed', scheduledAt: t, closedAt: t, events: [],
          detail: {}, failure: m.failed,
        });
        ref(n, e, id);
        if (m.failed) addFailure(n, 'localActivity', id, t, m.raw, 'failed', { fallback: m.failed });
        attach(n);
        // Local activities run inside the workflow task, so whatever the same
        // task schedules next can use their result.
        curParents = [n.id];
        break;
      }

      // ---------- end of workflow ----------
      case 'WORKFLOW_EXECUTION_COMPLETED':
      case 'WORKFLOW_EXECUTION_FAILED':
      case 'WORKFLOW_EXECUTION_TIMED_OUT':
      case 'WORKFLOW_EXECUTION_CANCELED':
      case 'WORKFLOW_EXECUTION_TERMINATED':
      case 'WORKFLOW_EXECUTION_CONTINUED_AS_NEW': {
        const parents = takeParents();
        const label = type === 'WORKFLOW_EXECUTION_COMPLETED' ? 'Completed'
          : type === 'WORKFLOW_EXECUTION_FAILED' ? 'Failed'
          : type === 'WORKFLOW_EXECUTION_TIMED_OUT' ? 'Timed out'
          : type === 'WORKFLOW_EXECUTION_CANCELED' ? 'Canceled'
          : type === 'WORKFLOW_EXECUTION_TERMINATED' ? 'Terminated' : 'Continued as new';
        status = type.replace('WORKFLOW_EXECUTION_', '');
        const state: NodeState = type === 'WORKFLOW_EXECUTION_COMPLETED' || type === 'WORKFLOW_EXECUTION_CONTINUED_AS_NEW'
          ? 'completed' : type === 'WORKFLOW_EXECUTION_FAILED' ? 'failed'
          : type === 'WORKFLOW_EXECUTION_TIMED_OUT' ? 'timedOut' : 'canceled';
        const n = add({
          id: 'end', kind: 'end', label, state, closedAt: t, events: [],
          detail: a.newExecutionRunId ? { 'New run ID': String(a.newExecutionRunId) } : {},
          result: decodePayloads(a.result),
          failure: describeFailure(a.failure) ?? (a.reason ? String(a.reason) : undefined),
        });
        n.durationMs = ms(startNode?.startedAt, t);
        ref(n, e, id);
        if (type === 'WORKFLOW_EXECUTION_FAILED' || type === 'WORKFLOW_EXECUTION_TIMED_OUT') {
          const own = parseFailure(a.failure) ?? synthFailure(type === 'WORKFLOW_EXECUTION_TIMED_OUT' ? 'Workflow execution timed out' : 'Workflow failed', type === 'WORKFLOW_EXECUTION_TIMED_OUT' ? 'Timeout (workflow)' : undefined);
          // A workflow failure that just wraps an activity or child failure is the same problem: it is kept for the end node
          // but flagged so counts and groups list the problem once.
          const same = failures.find((f) => sameCause(f.detail, own));
          failures.push({ id: `wf:${id}`, nodeId: 'end', label: workflowType || 'Workflow', kind: 'workflow', outcome: type === 'WORKFLOW_EXECUTION_TIMED_OUT' ? 'timedOut' : 'failed', eventId: id, time: t, detail: own, ...(same ? { duplicateOf: same.id } : {}) });
        }
        for (const p of parents) edges.push({ from: p, to: n.id });
        break;
      }
      default:
        break;
    }
  }

  // Pending activities carry the live retry state that history does not.
  for (const pa of opts.pendingActivities ?? []) {
    const n = nodes.find((x) => x.kind === 'activity' && x.detail['Activity ID'] === String(pa.activityId));
    if (!n || n.closedAt) continue;
    n.attempt = pa.attempt ?? n.attempt;
    n.maxAttempts = pa.maximumAttempts && pa.maximumAttempts > 0 ? pa.maximumAttempts : n.maxAttempts;
    const lf = describeFailure(pa.lastFailure);
    if (lf) n.failure = `Last attempt: ${lf}`;
    if (canon(pa.state) === 'SCHEDULED' && (pa.attempt ?? 1) > 1) n.state = 'retrying';
    if (pa.lastFailure) retryCandidate.set(n.id, { failure: pa.lastFailure, eventId: n.events[n.events.length - 1]?.id ?? 0, time: n.events[n.events.length - 1]?.time });
  }
  // An activity that is still open after a failed attempt is "retrying"; one that later completed is not a failure.
  for (const [nodeId, c] of retryCandidate) {
    const n = byId.get(nodeId);
    if (n && !n.closedAt) addFailure(n, 'activity', c.eventId, c.time, c.failure, 'retrying', { idSuffix: ':retry' });
  }
  failures.sort((x, y) => x.eventId - y.eventId);

  // The closing event is authoritative; describe() may be a poll behind.
  if (opts.workflowStatus && status === 'RUNNING') status = canon(opts.workflowStatus);
  return { nodes, edges: reduceEdges(edges), workflowType, status, warnings, failures };
}

/** Drops duplicate edges and edges already implied by a longer path. */
export function reduceEdges(edges: VEdge[]): VEdge[] {
  const key = (e: VEdge) => `${e.from}>${e.to}`;
  const seen = new Set<string>();
  const unique = edges.filter((e) => e.from !== e.to && !seen.has(key(e)) && seen.add(key(e)));
  const out = new Map<string, string[]>();
  for (const e of unique) (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.to);

  const reachable = (from: string, target: string, skip: string): boolean => {
    const stack = [...(out.get(from) ?? [])].filter((n) => !(from === skip && n === target));
    const visited = new Set<string>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === target) return true;
      if (visited.has(cur)) continue;
      visited.add(cur);
      stack.push(...(out.get(cur) ?? []));
    }
    return false;
  };
  return unique.filter((e) => !reachable(e.from, e.to, e.from));
}
