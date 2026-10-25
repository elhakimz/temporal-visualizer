import { canon, type HistoryEvent, type PendingActivity } from './core/history';

export interface WorkflowSummary {
  workflowId: string;
  runId: string;
  type: string;
  status: string;
  startTime?: string;
  closeTime?: string;
  taskQueue?: string;
  historyLength?: number;
  /** Set when this run was started by another workflow. */
  parentWorkflowId?: string;
}

export interface Description {
  status?: string;
  pendingActivities: PendingActivity[];
}

export interface HistoryPage { events: HistoryEvent[]; nextPageToken: string }

/** The calls a live feed needs; TemporalApi and the sample replay both provide them. */
export interface HistoryApi {
  describe(workflowId: string, runId: string): Promise<Description>;
  historyPage(workflowId: string, runId: string, o?: { token?: string; wait?: boolean; signal?: AbortSignal; pageSize?: number }): Promise<HistoryPage>;
  history(workflowId: string, runId: string): Promise<HistoryEvent[]>;
}

export class ApiError extends Error {
  constructor(message: string, public url: string, public httpStatus?: number) { super(message); }
}

/**
 * Talks to the HTTP API that the Temporal UI server exposes (port 8233 with
 * `temporal server start-dev`).  The gRPC port 7233 cannot be called from a browser.
 */
export class TemporalApi implements HistoryApi {
  constructor(public namespace = 'default', private base = '') {}

  private async get(path: string, signal?: AbortSignal): Promise<any> {
    const url = `${this.base}${path}`;
    let res: Response;
    try {
      res = await fetch(url, { headers: { accept: 'application/json' }, signal });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      throw new ApiError(`Network error: ${(err as Error).message}`, url);
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      throw new ApiError(body || res.statusText, url, res.status);
    }
    return res.json();
  }

  private async firstOk(paths: string[]): Promise<any> {
    let last: unknown;
    for (const p of paths) {
      try { return await this.get(p); } catch (err) { last = err; }
    }
    throw last;
  }

  private ns() { return `/api/v1/namespaces/${encodeURIComponent(this.namespace)}`; }

  async list(query: string, pageSize = 100): Promise<WorkflowSummary[]> {
    const q = new URLSearchParams({ pageSize: String(pageSize) });
    if (query.trim()) q.set('query', query.trim());
    const data = await this.get(`${this.ns()}/workflows?${q}`);
    return (data.executions ?? []).map((x: any) => ({
      workflowId: x.execution?.workflowId ?? '',
      runId: x.execution?.runId ?? '',
      type: x.type?.name ?? '',
      status: canon(x.status),
      startTime: x.startTime,
      closeTime: x.closeTime,
      taskQueue: x.taskQueue,
      historyLength: x.historyLength != null ? Number(x.historyLength) : undefined,
      parentWorkflowId: x.parentExecution?.workflowId || undefined,
    }));
  }

  async describe(workflowId: string, runId: string): Promise<Description> {
    const w = encodeURIComponent(workflowId);
    const r = encodeURIComponent(runId);
    const data = await this.firstOk([
      `${this.ns()}/workflows/${w}/runs/${r}`,
      `${this.ns()}/workflows/${w}?execution.runId=${r}`,
    ]);
    return {
      status: data.workflowExecutionInfo?.status,
      pendingActivities: data.pendingActivities ?? [],
    };
  }

  /**
   * One page of history from the gRPC-gateway route.  With `wait` the server holds the
   * request open until new events exist (the same mechanism as `temporal workflow show --follow`).
   */
  async historyPage(
    workflowId: string, runId: string,
    o: { token?: string; wait?: boolean; signal?: AbortSignal; pageSize?: number } = {},
  ): Promise<HistoryPage> {
    const q = new URLSearchParams({ 'execution.runId': runId, maximumPageSize: String(o.pageSize ?? 500) });
    if (o.token) q.set('nextPageToken', o.token);
    if (o.wait) q.set('waitNewEvent', 'true');
    const data = await this.get(`${this.ns()}/workflows/${encodeURIComponent(workflowId)}/history?${q}`, o.signal);
    return { events: (data.history?.events ?? []) as HistoryEvent[], nextPageToken: data.nextPageToken ?? '' };
  }

  async history(workflowId: string, runId: string): Promise<HistoryEvent[]> {
    const w = encodeURIComponent(workflowId);
    const r = encodeURIComponent(runId);
    const events: HistoryEvent[] = [];
    let token = '';
    for (let page = 0; page < 200; page++) {
      const tk = token ? `&nextPageToken=${encodeURIComponent(token)}` : '';
      const data = await this.firstOk([
        `${this.ns()}/workflows/${w}/runs/${r}/events?maximumPageSize=500${tk}`,
        `${this.ns()}/workflows/${w}/history?execution.runId=${r}&maximumPageSize=500${tk}`,
      ]);
      events.push(...((data.history?.events ?? data.events ?? []) as HistoryEvent[]));
      token = data.nextPageToken ?? '';
      if (!token) break;
    }
    return events;
  }
}
