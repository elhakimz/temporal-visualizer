// Failures as Temporal reports them: a chain of causes, each with a message, a type and (usually) a stack trace.
// This module parses them, groups them for triage and turns them into plain text for copying.

export interface FailureLink {
  /** application, timeout, activity, child workflow, canceled, terminated, server, failure */
  kind: string;
  /** Exception class for application failures ("java.lang.IllegalStateException"), "Timeout (start to close)", ... */
  type?: string;
  message: string;
  source?: string;
  stack?: string;
  /** Extra context from wrapper failures: activity name and id, retry state, child workflow id... */
  info?: string;
  nonRetryable?: boolean;
}

export interface FailureDetail {
  /** Outermost wrapper first, root cause last. */
  chain: FailureLink[];
  /** Type and message of the root cause. */
  type?: string;
  message: string;
  summary: string;
}

export type FailureOutcome = 'failed' | 'timedOut' | 'retrying';
export type FailureKind = 'activity' | 'localActivity' | 'child' | 'workflow' | 'workflowTask' | 'update';

export interface FailureItem {
  id: string;
  /** Graph node the failure belongs to; none for workflow-task failures. */
  nodeId?: string;
  label: string;
  kind: FailureKind;
  outcome: FailureOutcome;
  eventId: number;
  time?: string;
  detail: FailureDetail;
  /** Set when this only wraps another listed failure (a workflow failure caused by an activity failure). */
  duplicateOf?: string;
}

type Obj = Record<string, any>;

const enumWords = (v: unknown, prefix: RegExp) =>
  String(v ?? '').replace(prefix, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replaceAll('_', ' ').trim();

function decodeEncoded(p: unknown): { message?: string; stack?: string } {
  try {
    const raw = (p as Obj | undefined)?.data;
    if (!raw) return {};
    const text = new TextDecoder().decode(Uint8Array.from(atob(String(raw)), (c) => c.charCodeAt(0)));
    const j = JSON.parse(text);
    return { message: j.message, stack: j.stack_trace ?? j.stackTrace };
  } catch { return {}; }
}

function linkOf(f: Obj): FailureLink {
  let kind = 'failure', type: string | undefined, info: string | undefined, nonRetryable: boolean | undefined;
  if (f.applicationFailureInfo) {
    kind = 'application'; type = f.applicationFailureInfo.type || undefined;
    nonRetryable = f.applicationFailureInfo.nonRetryable === true ? true : undefined;
  } else if (f.timeoutFailureInfo) {
    kind = 'timeout'; type = `Timeout (${enumWords(f.timeoutFailureInfo.timeoutType, /^TIMEOUT_TYPE_/) || 'unknown'})`;
  } else if (f.canceledFailureInfo) { kind = 'canceled'; type = 'Canceled'; }
  else if (f.terminatedFailureInfo) { kind = 'terminated'; type = 'Terminated'; }
  else if (f.serverFailureInfo) { kind = 'server'; type = 'ServerFailure'; nonRetryable = f.serverFailureInfo.nonRetryable === true ? true : undefined; }
  else if (f.activityFailureInfo) {
    const a = f.activityFailureInfo; kind = 'activity'; type = 'ActivityFailure';
    info = [a.activityType?.name, a.activityId ? `id ${a.activityId}` : '', a.retryState ? enumWords(a.retryState, /^RETRY_STATE_/) : ''].filter(Boolean).join(' · ') || undefined;
  } else if (f.childWorkflowExecutionFailureInfo) {
    const c = f.childWorkflowExecutionFailureInfo; kind = 'child workflow'; type = 'ChildWorkflowFailure';
    info = [c.workflowType?.name, c.workflowExecution?.workflowId, c.retryState ? enumWords(c.retryState, /^RETRY_STATE_/) : ''].filter(Boolean).join(' · ') || undefined;
  }
  let message = String(f.message ?? '');
  let stack = typeof f.stackTrace === 'string' && f.stackTrace ? f.stackTrace : undefined;
  if (f.encodedAttributes && (!message || /^encoded failure$/i.test(message))) {       // failure converter encrypts message and stack
    const d = decodeEncoded(f.encodedAttributes); message = d.message ?? message; stack = stack ?? d.stack;
  }
  return { kind, type, message, source: f.source || undefined, stack, info, nonRetryable };
}

/** Parses a Temporal Failure object (JSON form) into its chain of causes. */
export function parseFailure(f: unknown): FailureDetail | undefined {
  if (!f || typeof f !== 'object') return undefined;
  const chain: FailureLink[] = [];
  for (let cur = f as Obj | undefined, i = 0; cur && typeof cur === 'object' && i < 24; cur = cur.cause, i++) chain.push(linkOf(cur));
  const root = chain[chain.length - 1];
  const message = root.message || [...chain].reverse().find((l) => l.message)?.message || '';
  const type = root.type ?? [...chain].reverse().find((l) => l.type)?.type;
  return { chain, type, message, summary: type && message ? `${type}: ${message}` : message || type || 'Failure' };
}

/** A failure we only know a sentence about (no Failure object in the event). */
export function synthFailure(message: string, type?: string, kind = 'failure'): FailureDetail {
  return { chain: [{ kind, type, message }], type, message, summary: type ? `${type}: ${message}` : message };
}

export const sameCause = (a: FailureDetail, b: FailureDetail) => a.type === b.type && a.message === b.message;

// ---------- display helpers ----------

/** "com.acme.InsufficientFundsException" -> "InsufficientFundsException". */
export function shortType(t?: string): string {
  if (!t) return '';
  if (/^[A-Za-z0-9_$.]+$/.test(t) && t.includes('.')) return t.slice(t.lastIndexOf('.') + 1);
  return t;
}

/** Replaces ids and numbers so "balance 12.50 below 129.90" and "balance 3.20 below 55.00" compare equal. */
export function normalizeMessage(m: string): string {
  return m
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b\d+(?:[.,]\d+)*\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

const firstLine = (s: string, max = 160) => { const l = s.split('\n')[0].trim(); return l.length > max ? l.slice(0, max - 1) + '…' : l; };

export interface FailureGroup { key: string; title: string; subtitle: string; items: FailureItem[] }

/** Groups failures by root-cause type, or by (normalised) message; biggest groups first. */
export function groupFailures(items: FailureItem[], by: 'type' | 'message'): FailureGroup[] {
  const groups = new Map<string, FailureItem[]>();
  for (const it of items) {
    if (it.duplicateOf) continue;
    const key = by === 'type'
      ? (it.detail.type ?? `no type: ${normalizeMessage(it.detail.message)}`)
      : (normalizeMessage(it.detail.message) || it.detail.type || 'unknown');
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(it);
  }
  const out: FailureGroup[] = [...groups].map(([key, list]) => {
    list.sort((a, b) => a.eventId - b.eventId);
    const first = list[0].detail;
    return by === 'type'
      ? { key, items: list, title: shortType(first.type) || firstLine(first.message) || 'Unknown failure', subtitle: first.type ? firstLine(first.message) : '' }
      : { key, items: list, title: firstLine(first.message) || shortType(first.type) || 'Unknown failure', subtitle: shortType(first.type) };
  });
  return out.sort((a, b) => b.items.length - a.items.length || a.items[0].eventId - b.items[0].eventId);
}

// ---------- stack traces ----------

const FRAME = /^\s+(at\s|File\s")/;
const FRAMEWORK = /^\s+at\s+(java\.|javax\.|jdk\.|sun\.|com\.sun\.|io\.temporal\.|org\.junit|org\.testng|go\.temporal\.io|runtime\.)|node_modules|node:internal|site-packages|\/go\/pkg\/mod\//;

/** 'framework' for JDK / Temporal SDK / dependency frames, 'app' for other frames, 'text' for everything else. */
export function classifyFrame(line: string): 'framework' | 'app' | 'text' {
  if (!FRAME.test(line)) return 'text';
  return FRAMEWORK.test(line) ? 'framework' : 'app';
}

// ---------- plain text ----------

const OUTCOME_WORDS: Record<FailureOutcome, string> = { failed: 'failed', timedOut: 'timed out', retrying: 'retrying' };
export const outcomeWords = (o: FailureOutcome) => OUTCOME_WORDS[o];

export function failureText(it: FailureItem): string {
  const lines = [`${it.label} ${OUTCOME_WORDS[it.outcome]} (event #${it.eventId}${it.time ? `, ${it.time}` : ''})`, it.detail.summary, ''];
  it.detail.chain.forEach((l, i) => {
    lines.push(`${'  '.repeat(Math.min(i, 6))}${i ? 'Caused by: ' : ''}${[l.type ?? l.kind, l.message].filter(Boolean).join(': ')}${l.info ? `  [${l.info}]` : ''}${l.nonRetryable ? '  [non-retryable]' : ''}`);
    if (l.stack) lines.push(l.stack, '');
  });
  return lines.join('\n').trimEnd();
}

export function groupsText(groups: FailureGroup[], title: string): string {
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const out = [`${title}: ${total} failure${total === 1 ? '' : 's'} in ${groups.length} group${groups.length === 1 ? '' : 's'}`, ''];
  for (const g of groups) {
    out.push(`${g.items.length} × ${g.title}${g.subtitle ? ` — ${g.subtitle}` : ''}`);
    for (const it of g.items) out.push(`  - ${it.label} ${OUTCOME_WORDS[it.outcome]} (event #${it.eventId})`);
    out.push('');
  }
  return out.join('\n').trimEnd();
}
