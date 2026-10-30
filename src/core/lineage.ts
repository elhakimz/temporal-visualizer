// How runs relate to each other: a child points at its parent, and a run that was continued (continue-as-new,
// retry, cron) points at the run before and after it.  Everything here is read from history events.

export interface RunRef { workflowId: string; runId: string; namespace?: string }

export type ContinueReason = 'continued-as-new' | 'retry' | 'cron';

export interface Lineage {
  /** Set when a parent workflow started this run; `initiatedEventId` is the parent's event that started it. */
  parent?: RunRef & { initiatedEventId?: number };
  /** The run this one continued from, and why it exists. */
  previousRunId?: string;
  origin?: ContinueReason;
  firstRunId?: string;
  /** The run that took over when this one ended. */
  nextRunId?: string;
  nextReason?: ContinueReason;
}

/** A child workflow as seen from its parent. `runId` is missing until the child has started. */
export interface ChildRef { workflowId: string; runId?: string; namespace?: string }

export interface StartInfo {
  type: string;
  parent?: Lineage['parent'];
  previousRunId?: string;
  origin?: ContinueReason;
  firstRunId?: string;
}

type Attrs = Record<string, any>;
const initiatorWord = (v: unknown) =>
  String(v ?? '').replace(/^CONTINUE_AS_NEW_INITIATOR_/, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();

/** Reads a WorkflowExecutionStarted event's attributes. */
export function startInfo(a: Attrs): StartInfo {
  const pe = a.parentWorkflowExecution;
  const initiated = a.parentInitiatedEventId != null && a.parentInitiatedEventId !== '' ? Number(a.parentInitiatedEventId) : undefined;
  const previousRunId = a.continuedExecutionRunId ? String(a.continuedExecutionRunId) : undefined;
  const w = initiatorWord(a.initiator);
  const origin: ContinueReason | undefined = w === 'RETRY' ? 'retry' : w === 'CRON_SCHEDULE' ? 'cron' : previousRunId ? 'continued-as-new' : undefined;
  return {
    type: a.workflowType?.name ?? '',
    parent: pe?.workflowId ? { workflowId: String(pe.workflowId), runId: String(pe.runId ?? ''), namespace: a.parentWorkflowNamespace || undefined, initiatedEventId: Number.isFinite(initiated) ? initiated : undefined } : undefined,
    previousRunId, origin,
    firstRunId: a.firstExecutionRunId ? String(a.firstExecutionRunId) : undefined,
  };
}

/** Why a run that ended with `newExecutionRunId` was followed by another one. */
export function nextReasonFor(terminalType: string): ContinueReason {
  return terminalType === 'WORKFLOW_EXECUTION_CONTINUED_AS_NEW' ? 'continued-as-new'
    : terminalType === 'WORKFLOW_EXECUTION_COMPLETED' ? 'cron' : 'retry';
}

export const reasonWords = (r?: ContinueReason) => r === 'retry' ? 'retry' : r === 'cron' ? 'cron schedule' : 'continue-as-new';

export interface Ancestor {
  ref: RunRef;
  type: string;
  /** Event id, in this ancestor's history, of the child start that leads towards the run being viewed. */
  focusChild?: number;
}

/**
 * Walks up from a run's parent to the root.  `first` returns the first-event info of a run (a single small request
 * in practice).  Nearest parent first; stops at the root, a loop, or `max` levels.
 */
export async function resolveAncestors(
  first: (ref: RunRef) => Promise<StartInfo | undefined>, parent: Lineage['parent'], max = 8,
): Promise<Ancestor[]> {
  const out: Ancestor[] = [], seen = new Set<string>();
  let ref: Lineage['parent'] = parent, via = parent?.initiatedEventId;
  while (ref && out.length < max) {
    const key = `${ref.namespace ?? ''}/${ref.workflowId}/${ref.runId}`;
    if (seen.has(key)) break;
    seen.add(key);
    let info: StartInfo | undefined;
    try { info = await first(ref); } catch { info = undefined; }
    out.push({ ref: { workflowId: ref.workflowId, runId: ref.runId, namespace: ref.namespace }, type: info?.type ?? '', focusChild: via });
    via = info?.parent?.initiatedEventId;
    ref = info?.parent;
  }
  return out;
}
