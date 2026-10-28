import { diffGraphs, type GraphDiff } from './core/diff';
import type { HistoryEvent, VGraph } from './core/history';
import { buildSteps, fmtOffset, graphAtStep, nearestStep, playDelay, stepPositions, type Step, type StepKind } from './core/timeline';

export interface ScrubChange { graph: VGraph; diff: GraphDiff; step: Step; p: number; total: number; atEnd: boolean }

const KIND_COLOR: Record<StepKind, string> = {
  failure: '#BF3A30', done: '#1B7F63', signal: '#2F63C8', cancel: '#6F7F90', progress: '#9AA9B6',
};
const SPEEDS = [1, 2, 4, .5];
const PAD = 14;                  // horizontal padding inside the track canvas
const RAIL_Y = 24;

/**
 * Replay controls for a finished run: play/pause, step buttons and a draggable track whose ticks are the
 * moments that changed the graph.  It rebuilds the graph as it stood at the chosen step and reports the
 * change; the page applies it to the canvas.
 */
export class Scrubber {
  steps: Step[] = [];
  p = 0;
  playing = false;

  private events: HistoryEvent[] = [];
  private graph: VGraph | null = null;
  private pos: number[] = [];
  private mode: 'steps' | 'time' = 'steps';
  private speed = 1;
  private timer: number | undefined;
  private raf = 0;
  private target = 0;
  private dragging = false;
  private hover = -1;
  private w = 0;
  private ctx: CanvasRenderingContext2D;
  private el: Record<'prev' | 'play' | 'next' | 'speed' | 'scale' | 'end' | 'step' | 'what' | 'tip', HTMLElement> & { track: HTMLCanvasElement };

  constructor(private root: HTMLElement, private onChange: (c: ScrubChange) => void) {
    const q = <T extends HTMLElement>(id: string) => root.querySelector<T>('#' + id)!;
    this.el = { prev: q('sc-prev'), play: q('sc-play'), next: q('sc-next'), speed: q('sc-speed'), scale: q('sc-scale'),
      end: q('sc-end'), step: q('sc-step'), what: q('sc-what'), tip: q('sc-tip'), track: q<HTMLCanvasElement>('sc-track') };
    this.ctx = this.el.track.getContext('2d')!;

    this.el.prev.addEventListener('click', () => { this.pause(); this.goto(this.p - 1, true); });
    this.el.next.addEventListener('click', () => { this.pause(); this.goto(this.p + 1, true); });
    this.el.end.addEventListener('click', () => { this.pause(); this.goto(this.steps.length, true); });
    this.el.play.addEventListener('click', () => (this.playing ? this.pause() : this.play()));
    this.el.speed.addEventListener('click', () => {
      this.speed = SPEEDS[(SPEEDS.indexOf(this.speed) + 1) % SPEEDS.length];
      this.el.speed.textContent = `${this.speed}×`;
    });
    this.el.scale.addEventListener('click', () => {
      this.mode = this.mode === 'steps' ? 'time' : 'steps';
      this.el.scale.setAttribute('aria-pressed', String(this.mode === 'time'));
      this.pos = stepPositions(this.steps, this.mode);
      this.draw();
    });

    const t = this.el.track;
    const fracOf = (e: PointerEvent) => { const r = t.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left - PAD) / (r.width - PAD * 2))); };
    t.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.steps.length) return;
      this.pause(); this.dragging = true; t.setPointerCapture(e.pointerId); t.focus();
      this.goto(nearestStep(this.pos, fracOf(e)));
      e.preventDefault();
    });
    t.addEventListener('pointermove', (e) => {
      if (!this.steps.length) return;
      const p = nearestStep(this.pos, fracOf(e));
      if (this.dragging) this.goto(p);
      this.hover = p - 1; this.showTip(); this.draw();
    });
    const release = () => { this.dragging = false; };
    t.addEventListener('pointerup', release);
    t.addEventListener('pointercancel', release);
    t.addEventListener('pointerleave', () => { this.hover = -1; this.el.tip.hidden = true; this.draw(); });
    t.addEventListener('keydown', (e) => {
      const key = e.key, big = e.shiftKey ? 10 : 1;
      const to = key === 'ArrowLeft' || key === 'ArrowDown' ? this.p - big
        : key === 'ArrowRight' || key === 'ArrowUp' ? this.p + big
        : key === 'PageDown' ? this.p - 10 : key === 'PageUp' ? this.p + 10
        : key === 'Home' ? 1 : key === 'End' ? this.steps.length : null;
      if (key === ' ' || key === 'Enter') { e.preventDefault(); this.playing ? this.pause() : this.play(); return; }
      if (to === null) return;
      e.preventDefault(); this.pause(); this.goto(to, true);
    });
    new ResizeObserver(() => this.resize()).observe(this.el.track.parentElement!);
  }

  get visible() { return !this.root.hidden; }

  /** Starts at the end of the run; `finalGraph` is what the page is already showing. */
  load(events: HistoryEvent[], finalGraph: VGraph) {
    this.pause();
    this.events = events;
    this.steps = buildSteps(events, finalGraph);
    if (this.steps.length < 2) { this.unload(); return; }
    this.p = this.steps.length;
    this.graph = finalGraph;
    this.pos = stepPositions(this.steps, this.mode);
    this.root.hidden = false;
    this.resize();
    this.refresh();
  }

  unload() {
    this.pause();
    window.cancelAnimationFrame(this.raf); this.raf = 0;
    this.steps = []; this.events = []; this.graph = null; this.p = 0; this.hover = -1;
    this.root.hidden = true; this.el.tip.hidden = true;
  }

  /** Jump to step `p` (1-based). Dragging is coalesced to one update per frame; buttons apply at once. */
  goto(p: number, now = false) {
    if (!this.steps.length) return;
    const clamped = Math.min(this.steps.length, Math.max(1, Math.round(p)));
    if (now) { window.cancelAnimationFrame(this.raf); this.raf = 0; this.apply(clamped); return; }
    this.target = clamped;
    if (!this.raf) this.raf = window.requestAnimationFrame(() => { this.raf = 0; this.apply(this.target); });
  }

  /** Moves forward, if needed, so that history event `eventId` has happened; never moves back. */
  ensureAt(eventId: number) {
    if (!this.steps.length) return;
    this.pause();
    const i = this.steps.findIndex((s) => s.eventId >= eventId);
    const want = i < 0 ? this.steps.length : i + 1;
    if (want > this.p) this.goto(want, true);
  }

  play() {
    if (this.steps.length < 2) return;
    if (this.p >= this.steps.length) this.apply(1);
    this.playing = true; this.syncPlayButton(); this.schedule();
  }

  pause() {
    window.clearTimeout(this.timer); this.timer = undefined;
    if (this.playing) { this.playing = false; this.syncPlayButton(); }
  }

  // ---------- internals ----------
  private schedule() {
    this.timer = window.setTimeout(() => {
      if (!this.playing) return;
      this.apply(this.p + 1);
      if (this.p >= this.steps.length) this.pause(); else this.schedule();
    }, playDelay(this.steps, this.p, this.mode, this.speed));
  }

  private apply(p: number) {
    if (p === this.p) { this.refresh(); return; }
    const graph = graphAtStep(this.events, this.steps, p);
    const diff = diffGraphs(this.graph, graph);
    this.p = p; this.graph = graph;
    this.refresh();
    this.onChange({ graph, diff, step: this.steps[p - 1], p, total: this.steps.length, atEnd: p === this.steps.length });
  }

  private syncPlayButton() {
    this.el.play.dataset.state = this.playing ? 'playing' : 'paused';
    this.el.play.setAttribute('aria-label', this.playing ? 'Pause' : 'Play');
  }

  private refresh() {
    const n = this.steps.length, s = this.steps[this.p - 1]; if (!s) return;
    const clock = s.time ? new Date(s.time).toLocaleTimeString([], { hour12: false }) : '';
    this.el.step.textContent = `Step ${this.p} of ${n} · ${fmtOffset(s.ms)}`;
    this.el.what.dataset.kind = s.kind;
    this.el.what.replaceChildren(`${clock ? clock + '  ' : ''}#${s.eventId}  `, Object.assign(document.createElement('b'), { textContent: s.label }), ` ${s.words}${this.p === n ? ' · final state' : ''}`);
    (this.el.prev as HTMLButtonElement).disabled = this.p <= 1;
    (this.el.next as HTMLButtonElement).disabled = this.p >= n;
    (this.el.end as HTMLButtonElement).disabled = this.p >= n;
    const t = this.el.track;
    t.setAttribute('aria-valuemin', '1'); t.setAttribute('aria-valuemax', String(n)); t.setAttribute('aria-valuenow', String(this.p));
    t.setAttribute('aria-valuetext', `Step ${this.p} of ${n}: ${s.label} ${s.words}, ${fmtOffset(s.ms)}`);
    this.root.dataset.step = String(this.p); this.root.dataset.total = String(n); this.root.dataset.nodes = String(this.graph?.nodes.length ?? 0);
    this.syncPlayButton();
    this.draw();
  }

  private showTip() {
    const s = this.steps[this.hover]; if (!s) { this.el.tip.hidden = true; return; }
    this.el.tip.textContent = `${fmtOffset(s.ms)} · ${s.label} ${s.words}`;
    this.el.tip.hidden = false;
    const x = PAD + this.pos[this.hover] * (this.w - PAD * 2);
    const half = this.el.tip.offsetWidth / 2;
    this.el.tip.style.left = `${Math.min(this.w - half, Math.max(half, x))}px`;
  }

  private resize() {
    const t = this.el.track, dpr = window.devicePixelRatio || 1;
    this.w = t.parentElement!.clientWidth;
    t.width = Math.max(1, Math.floor(this.w * dpr)); t.height = Math.floor(44 * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  private draw() {
    const c = this.ctx, w = this.w, n = this.steps.length;
    c.clearRect(0, 0, w, 44);
    if (!n || w < 40) return;
    const x0 = PAD, x1 = w - PAD, px = (i: number) => x0 + this.pos[i] * (x1 - x0), cur = px(this.p - 1);
    c.lineCap = 'round';
    c.strokeStyle = '#D5DCE2'; c.lineWidth = 4; c.beginPath(); c.moveTo(x0, RAIL_Y); c.lineTo(x1, RAIL_Y); c.stroke();
    c.strokeStyle = '#1B7F63'; c.beginPath(); c.moveTo(x0, RAIL_Y); c.lineTo(cur, RAIL_Y); c.stroke();
    for (let i = 0; i < n; i++) {
      const s = this.steps[i], reached = i < this.p, big = s.kind === 'failure';
      c.globalAlpha = reached ? 1 : .45; c.strokeStyle = KIND_COLOR[s.kind]; c.lineWidth = big ? 3 : 2;
      c.beginPath(); c.moveTo(px(i), RAIL_Y - (big ? 11 : 7)); c.lineTo(px(i), RAIL_Y + (big ? 11 : 7)); c.stroke();
    }
    c.globalAlpha = 1;
    if (this.hover >= 0 && this.hover !== this.p - 1) { c.strokeStyle = 'rgba(23,34,44,.35)'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(px(this.hover), 4); c.lineTo(px(this.hover), 34); c.stroke(); }
    // playhead
    c.fillStyle = '#FFFFFF'; c.strokeStyle = '#17222C'; c.lineWidth = 2.4;
    c.beginPath(); c.arc(cur, RAIL_Y, 8, 0, Math.PI * 2); c.fill(); c.stroke();
    c.font = '11px "Inter", sans-serif'; c.fillStyle = '#6D8794'; c.textBaseline = 'alphabetic';
    c.textAlign = 'left'; c.fillText(this.mode === 'time' ? '+0 s' : 'start', x0, 42);
    c.textAlign = 'right'; c.fillText(fmtOffset(this.steps[n - 1].ms), x1, 42);
  }
}
