import type { HistoryEvent } from './core/history';
import type { Description, HistoryApi, HistoryPage } from './temporal';

/**
 * Plays a recorded history back as if the workflow were running, so the live view
 * can be tried without a Temporal server.  Implements the same calls a real server does,
 * including a long-poll that waits for the next event.
 */
export class ReplayApi implements HistoryApi {
  private shown = 3;
  private waiters: (() => void)[] = [];
  private stopped = false;

  constructor(private all: HistoryEvent[], private stepMs = 450) {
    void this.run();
  }

  stop() { this.stopped = true; this.wake(); }

  private wake() { this.waiters.splice(0).forEach((w) => w()); }

  private async run() {
    while (!this.stopped && this.shown < this.all.length) {
      const upcoming = String(this.all[this.shown].eventType);
      // Linger before the activity gives up, so the retry state is visible.
      await new Promise((r) => setTimeout(r, upcoming.includes('ACTIVITY_TASK_FAILED') ? 3500 : this.stepMs));
      if (this.stopped) return;
      this.shown++;
      this.wake();
    }
  }

  private pendingShip() {
    const idx = (suffix: string) => this.all.findIndex((e) => String(e.eventType).endsWith(suffix) && JSON.stringify(e).includes('ShipOrder'));
    const scheduled = idx('ACTIVITY_TASK_SCHEDULED');
    const failed = this.all.findIndex((e) => String(e.eventType).endsWith('ACTIVITY_TASK_FAILED'));
    if (scheduled < 0 || this.shown <= scheduled || this.shown > failed) return [];
    const retrying = this.shown >= failed;
    return [{
      activityId: '4', activityType: { name: 'ShipOrder' }, maximumAttempts: 3,
      state: retrying ? 'PENDING_ACTIVITY_STATE_SCHEDULED' : 'PENDING_ACTIVITY_STATE_STARTED',
      attempt: retrying ? 2 : 1,
      lastFailure: retrying ? { message: 'activity failed', cause: { message: 'carrier API 503', applicationFailureInfo: { type: 'CarrierUnavailable' } } } : undefined,
    }];
  }

  async describe(): Promise<Description> {
    return { status: this.shown >= this.all.length ? 'Failed' : 'Running', pendingActivities: this.pendingShip() };
  }

  async historyPage(_w: string, _r: string, o: { token?: string; wait?: boolean; signal?: AbortSignal } = {}): Promise<HistoryPage> {
    const from = o.token ? Number(o.token) : 0;
    if (o.wait && from >= this.shown && !this.stopped) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        o.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      if (o.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    }
    const events = this.all.slice(from, this.shown);
    const done = this.shown >= this.all.length && from + events.length >= this.all.length;
    return { events, nextPageToken: done ? '' : String(from + events.length) };
  }

  async history(): Promise<HistoryEvent[]> { return this.all.slice(0, this.shown); }
}
