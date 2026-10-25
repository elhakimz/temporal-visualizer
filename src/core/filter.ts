import type { WorkflowSummary } from '../temporal';

export type StatusFilter = 'failures' | 'running' | null;
export type TimeFilter = 'today' | 'hour' | null;

export interface ListFilter {
  status: StatusFilter;
  /** Top-level workflows only: hides child workflows. */
  parent: boolean;
  time: TimeFilter;
}

export const NO_FILTER: ListFilter = { status: null, parent: false, time: null };

export const isUnfiltered = (f: ListFilter) => f.status === null && !f.parent && f.time === null;

/** A run counts as a failure when it failed or timed out; deliberate terminations do not. */
export const isFailure = (w: WorkflowSummary) => w.status === 'FAILED' || w.status === 'TIMED_OUT';

export function matches(w: WorkflowSummary, f: ListFilter, now = Date.now()): boolean {
  if (f.status === 'failures' && !isFailure(w)) return false;
  if (f.status === 'running' && w.status !== 'RUNNING') return false;
  if (f.parent && w.parentWorkflowId) return false;
  if (f.time) {
    const started = w.startTime ? Date.parse(w.startTime) : NaN;
    if (!Number.isFinite(started)) return false;
    if (f.time === 'hour' && started < now - 3_600_000) return false;
    if (f.time === 'today') {
      const midnight = new Date(now);
      midnight.setHours(0, 0, 0, 0);
      if (started < midnight.getTime()) return false;
    }
  }
  return true;
}

export const applyFilter = (items: WorkflowSummary[], f: ListFilter, now = Date.now()) =>
  items.filter((w) => matches(w, f, now));

/** How many failures a click on "Failures" would show, given the other active filters. */
export const failureCount = (items: WorkflowSummary[], f: ListFilter, now = Date.now()) =>
  applyFilter(items, { ...f, status: 'failures' }, now).length;
