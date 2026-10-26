import { diffGraphs, isEmpty, summarize, type GraphDiff } from './core/diff';
import { buildGraph, type HistoryEvent, type VGraph } from './core/history';
import type { Description, HistoryApi } from './temporal';

export type FeedMode = 'long-poll' | 'poll';

export type FeedEvent =
  | { type: 'snapshot'; graph: VGraph }
  | { type: 'update'; graph: VGraph; diff: GraphDiff; messages: string[] }
  | { type: 'mode'; mode: FeedMode }
  | { type: 'closed'; graph: VGraph }
  | { type: 'error'; error: unknown };

export type FeedListener = (e: FeedEvent) => void;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

const isAbort = (err: unknown) => (err as Error)?.name === 'AbortError';

/**
 * Follows one workflow run and tells subscribers what changed.
 *
 * Transport: long-polls the history endpoint (`waitNewEvent`) so a new event arrives the
 * moment the server has it.  If the server answers instantly without events, or the route is
 * missing, it falls back to polling every second.  Retry counts live in the describe call,
 * not in history, so that is refreshed on its own short timer.
 */
export class WorkflowFeed {
  graph: VGraph | null = null;
  mode: FeedMode = 'long-poll';

  private listeners = new Set<FeedListener>();
  private abort = new AbortController();
  private events: HistoryEvent[] = [];
  private desc: Description | null = null;
  private descSig = '';
  private descTimer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(private api: HistoryApi, readonly workflowId: string, readonly runId: string) {}

  /** Every event received so far (the whole history once the run has closed). */
  get history(): HistoryEvent[] { return this.events; }

  subscribe(fn: FeedListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  stop() {
    this.stopped = true;
    this.abort.abort();
    clearInterval(this.descTimer);
  }

  /** Loads the current history, then keeps following until the workflow closes or stop() is called. */
  async start(opts: { follow: boolean } = { follow: true }) {
    const { signal } = this.abort;
    try {
      this.desc = await this.api.describe(this.workflowId, this.runId).catch(() => null);
      this.descSig = this.sigOf(this.desc);
      let token = '';
      try {
        ({ events: this.events, token } = await this.loadAll());
      } catch (err) {
        if (isAbort(err)) return;
        this.events = await this.api.history(this.workflowId, this.runId);
        this.setMode('poll');
      }
      this.publish(true);
      if (!opts.follow || this.graph!.status !== 'RUNNING') { this.finish(); return; }

      this.descTimer = setInterval(() => this.refreshDescribe(), 1500);
      let quick = 0;
      while (!this.stopped && this.graph!.status === 'RUNNING') {
        try {
          if (this.mode === 'long-poll') {
            const t0 = Date.now();
            const page = await this.api.historyPage(this.workflowId, this.runId, { token, wait: true, signal });
            if (this.stopped) return;
            token = page.nextPageToken || token;
            if (page.events.length) {
              this.events = [...this.events, ...page.events];
              this.publish(false);
              quick = 0;
            } else if (Date.now() - t0 < 400) {
              if (++quick >= 3) this.setMode('poll');
              await sleep(500, signal);
            } else quick = 0;
          } else {
            await sleep(1000, signal);
            if (this.stopped) return;
            const all = await this.api.history(this.workflowId, this.runId);
            if (all.length !== this.events.length) { this.events = all; this.publish(false); }
          }
        } catch (err) {
          if (isAbort(err) || this.stopped) return;
          if (this.mode === 'long-poll') this.setMode('poll');
          else { this.emit({ type: 'error', error: err }); await sleep(2000, signal); }
        }
      }
      this.finish();
    } catch (err) {
      if (!isAbort(err)) this.emit({ type: 'error', error: err });
    }
  }

  private async loadAll(): Promise<{ events: HistoryEvent[]; token: string }> {
    const events: HistoryEvent[] = [];
    let token = '';
    for (let i = 0; i < 400; i++) {
      const page = await this.api.historyPage(this.workflowId, this.runId, { token, signal: this.abort.signal });
      events.push(...page.events);
      token = page.nextPageToken;
      if (!token || page.events.length === 0) break;
    }
    return { events, token };
  }

  private sigOf(d: Description | null) {
    return JSON.stringify([d?.status, (d?.pendingActivities ?? []).map((p) => [p.activityId, p.state, p.attempt])]);
  }

  private async refreshDescribe() {
    if (this.stopped || !this.graph || this.graph.status !== 'RUNNING') return;
    const d = await this.api.describe(this.workflowId, this.runId).catch(() => null);
    if (!d || this.stopped) return;
    const sig = this.sigOf(d);
    if (sig === this.descSig) return;
    this.desc = d;
    this.descSig = sig;
    this.publish(false);
  }

  private publish(first: boolean) {
    const next = buildGraph(this.events, {
      pendingActivities: this.desc?.pendingActivities,
      workflowStatus: this.desc?.status,
    });
    if (first || !this.graph) {
      this.graph = next;
      this.emit({ type: 'snapshot', graph: next });
      return;
    }
    const diff = diffGraphs(this.graph, next);
    this.graph = next;
    if (!isEmpty(diff)) this.emit({ type: 'update', graph: next, diff, messages: summarize(diff) });
  }

  private finish() {
    clearInterval(this.descTimer);
    if (this.graph && !this.stopped) this.emit({ type: 'closed', graph: this.graph });
  }

  private setMode(mode: FeedMode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.emit({ type: 'mode', mode });
  }

  private emit(e: FeedEvent) {
    for (const fn of [...this.listeners]) {
      try { fn(e); } catch (err) { console.error('feed listener failed', err); }
    }
  }
}
