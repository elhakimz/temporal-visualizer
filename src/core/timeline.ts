import { buildGraph, canon, type HistoryEvent, type VGraph } from './history';

/**
 * A step is one event that changes what the graph shows (an activity scheduled, a timer
 * fired, a signal received...).  Workflow-task bookkeeping events are skipped, because stepping
 * through them would show nothing; workflow-task failures are kept because they matter.
 */
export type StepKind = 'failure' | 'done' | 'signal' | 'cancel' | 'progress';

export interface Step {
  /** Index into the event list; the graph at this step is built from events[0..index]. */
  index: number;
  eventId: number;
  type: string;
  kind: StepKind;
  /** Milliseconds since the first event. */
  ms: number;
  time?: string;
  nodeId?: string;
  label: string;
  words: string;
}

const WORDS: Record<string, string> = {
  WORKFLOW_EXECUTION_STARTED: 'workflow started',
  WORKFLOW_EXECUTION_COMPLETED: 'workflow completed',
  WORKFLOW_EXECUTION_FAILED: 'workflow failed',
  WORKFLOW_EXECUTION_TIMED_OUT: 'workflow timed out',
  WORKFLOW_EXECUTION_CANCELED: 'workflow canceled',
  WORKFLOW_EXECUTION_TERMINATED: 'workflow terminated',
  WORKFLOW_EXECUTION_CONTINUED_AS_NEW: 'continued as new',
  WORKFLOW_EXECUTION_SIGNALED: 'signal received',
  WORKFLOW_EXECUTION_UPDATE_ACCEPTED: 'update accepted',
  WORKFLOW_EXECUTION_UPDATE_COMPLETED: 'update completed',
  WORKFLOW_TASK_FAILED: 'workflow task failed',
  WORKFLOW_TASK_TIMED_OUT: 'workflow task timed out',
  MARKER_RECORDED: 'recorded',
  TIMER_STARTED: 'timer started',
  TIMER_FIRED: 'timer fired',
  TIMER_CANCELED: 'timer canceled',
  START_CHILD_WORKFLOW_EXECUTION_INITIATED: 'scheduled',
  START_CHILD_WORKFLOW_EXECUTION_FAILED: 'could not start',
};

/** "ACTIVITY_TASK_TIMED_OUT" -> "timed out". */
export function eventWords(type: string): string {
  const t = canon(type);
  if (WORDS[t]) return WORDS[t];
  return t.replace(/^(ACTIVITY_TASK_|CHILD_WORKFLOW_EXECUTION_)/, '').toLowerCase().replaceAll('_', ' ');
}

export function kindOf(type: string): StepKind {
  const t = canon(type);
  if (/FAILED|TIMED_OUT|TERMINATED/.test(t)) return 'failure';
  if (/CANCEL/.test(t)) return 'cancel';
  if (/SIGNALED|UPDATE_ACCEPTED/.test(t)) return 'signal';
  if (/COMPLETED|FIRED/.test(t)) return 'done';
  return 'progress';
}

/** `finalGraph` is the graph of the whole run; each of its nodes lists the events that belong to it. */
export function buildSteps(events: HistoryEvent[], finalGraph: VGraph): Step[] {
  const owner = new Map<number, { id: string; label: string }>();
  for (const n of finalGraph.nodes) for (const e of n.events) owner.set(e.id, { id: n.id, label: n.label });
  const t0 = events.length ? Date.parse(String(events[0].eventTime ?? '')) : NaN;
  const steps: Step[] = [];
  events.forEach((e, index) => {
    const id = Number(e.eventId), type = canon(e.eventType);
    const node = owner.get(id);
    const wfTaskProblem = type === 'WORKFLOW_TASK_FAILED' || type === 'WORKFLOW_TASK_TIMED_OUT';
    if (!node && !wfTaskProblem) return;
    const at = Date.parse(String(e.eventTime ?? ''));
    const whole = node?.id === 'start' || node?.id === 'end';      // "Workflow failed", not "Failed workflow failed"
    steps.push({
      index, eventId: id, type, kind: kindOf(type), time: e.eventTime,
      ms: Number.isFinite(at) && Number.isFinite(t0) ? Math.max(0, at - t0) : index,
      nodeId: node?.id, label: whole ? 'Workflow' : node?.label ?? 'Workflow task',
      words: whole ? eventWords(type).replace(/^workflow /, '') : eventWords(type),
    });
  });
  return steps;
}

/** The graph as it stood right after step `p` (1-based). */
export function graphAtStep(events: HistoryEvent[], steps: Step[], p: number): VGraph {
  if (p < 1 || !steps.length) return buildGraph([]);
  return buildGraph(events.slice(0, steps[Math.min(p, steps.length) - 1].index + 1));
}

/** Horizontal position (0..1) of every step on the track: evenly spaced, or proportional to real time. */
export function stepPositions(steps: Step[], mode: 'steps' | 'time'): number[] {
  const n = steps.length;
  if (n < 2) return steps.map(() => 0);
  const total = steps[n - 1].ms - steps[0].ms;
  if (mode === 'time' && total > 0) return steps.map((s) => (s.ms - steps[0].ms) / total);
  return steps.map((_, i) => i / (n - 1));
}

/** 1-based step whose position is closest to `f` (0..1). */
export function nearestStep(pos: number[], f: number): number {
  let lo = 0, hi = pos.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (pos[mid] < f) lo = mid + 1; else hi = mid; }
  if (lo > 0 && Math.abs(pos[lo - 1] - f) <= Math.abs(pos[lo] - f)) lo--;
  return lo + 1;
}

/** "+0.42 s", "+12.3 s", "+2 min 05 s". */
export function fmtOffset(ms: number): string {
  if (ms < 1000) return `+${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `+${s < 10 ? s.toFixed(2) : s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `+${m} min ${String(Math.round(s - m * 60)).padStart(2, '0')} s`;
  return `+${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** How long to wait before showing the step after `p` while playing (ms). */
export function playDelay(steps: Step[], p: number, mode: 'steps' | 'time', speed: number): number {
  if (mode === 'steps' || p >= steps.length) return 650 / speed;
  const total = steps[steps.length - 1].ms - steps[0].ms;
  const compress = total > 24_000 ? 24_000 / total : 1;           // long runs are sped up to about 24 s
  const gap = (steps[p].ms - steps[p - 1].ms) * compress;
  return Math.min(1800, Math.max(90, gap / speed));
}
