import { LGraph, LGraphCanvas, LGraphNode, LiteGraph, RenderShape } from '@comfyorg/litegraph';
import '@comfyorg/litegraph/style.css';
import type { NodeKind, NodeState, VGraph, VNode } from './core/history';
import { isStructural, type GraphDiff } from './core/diff';
import { layoutGraph } from './core/layout';

export const STATE_COLOR: Record<NodeState, { solid: string; tint: string; label: string }> = {
  scheduled: { solid: '#6F7F90', tint: '#EEF1F4', label: 'Scheduled' },
  running:   { solid: '#2F63C8', tint: '#E6EEFB', label: 'Running' },
  retrying:  { solid: '#B26B00', tint: '#FBF0DC', label: 'Retrying' },
  completed: { solid: '#1B7F63', tint: '#E4F3EC', label: 'Completed' },
  failed:    { solid: '#BF3A30', tint: '#FBE7E4', label: 'Failed' },
  timedOut:  { solid: '#8E3F86', tint: '#F4E6F2', label: 'Timed out' },
  canceled:  { solid: '#5B6670', tint: '#E9ECEF', label: 'Canceled' },
};

const KIND_NAME: Record<NodeKind, string> = {
  start: 'Workflow started', activity: 'Activity', localActivity: 'Local activity', timer: 'Timer',
  child: 'Child workflow', signal: 'Signal', update: 'Update', end: 'Workflow ended',
};

export function formatDuration(ms?: number): string {
  if (ms == null || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${Math.round(s - m * 60)} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function statusLine(v: VNode): string {
  const base = STATE_COLOR[v.state].label;
  const dur = formatDuration(v.durationMs);
  const tries = v.attempt && v.attempt > 1
    ? `, attempt ${v.attempt}${v.maxAttempts ? ` of ${v.maxAttempts}` : ''}` : '';
  if (v.state === 'completed' && dur) return `${base} in ${dur}${tries}`;
  if (v.kind === 'signal' || v.kind === 'start') return '';
  return `${base}${dur ? ` after ${dur}` : ''}${tries}`;
}

function fit(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

const FLASH_MS = 1600;
const TWEEN_MS = 280;
const TITLE_H = 30;
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

class StepNode extends LGraphNode {
  v?: VNode;
  flashUntil = 0;
  constructor(title = 'Step') {
    super(title);
    this.serialize_widgets = false;
  }
  onDrawForeground(ctx: CanvasRenderingContext2D): void {
    const v = this.v;
    if (!v || this.flags.collapsed) return;
    const w = this.size[0];
    const color = STATE_COLOR[v.state].solid;
    const pad = 20;
    ctx.save();
    ctx.textBaseline = 'alphabetic';
    ctx.font = '11px "IBM Plex Sans", "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = '#56626E';
    ctx.fillText(KIND_NAME[v.kind], pad, 18);

    const line = statusLine(v);
    if (line) {
      ctx.font = '600 12px "IBM Plex Sans", "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = color;
      ctx.fillText(fit(ctx, line, w - pad * 2), pad, 38);
    }
    if (v.failure && (v.state === 'failed' || v.state === 'timedOut' || v.state === 'retrying' || v.kind === 'end')) {
      ctx.font = '11px "IBM Plex Sans", "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = STATE_COLOR.failed.solid;
      ctx.fillText(fit(ctx, v.failure, w - pad * 2), pad, line ? 54 : 38);
    }
    if (v.state === 'running' || v.state === 'retrying') {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 4, this.size[1]);
    }
    // A state change outlines the whole node (title bar included) and fades out.
    const left = this.flashUntil - performance.now();
    if (left > 0) {
      ctx.globalAlpha = Math.min(1, left / FLASH_MS);
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.strokeRect(-5, -TITLE_H - 5, w + 10, this.size[1] + TITLE_H + 10);
    }
    ctx.restore();
  }
}

LiteGraph.registerNodeType('temporal/step', StepNode);
LiteGraph.NODE_TITLE_COLOR = '#FFFFFF';
LiteGraph.NODE_TEXT_COLOR = '#2B3640';

type Pos = [number, number];
interface Tween { node: StepNode; from: Pos; to: Pos; t0: number }

const MIN_READABLE_ZOOM = 0.7;

export class GraphView {
  private graph = new LGraph();
  private canvas: LGraphCanvas;
  private nodes = new Map<string, StepNode>();
  /** Where auto-layout last put each node; a node away from it was dragged by the user. */
  private auto = new Map<string, Pos>();
  private tweens: Tween[] = [];
  private raf = 0;
  private rebuilding = false;
  private selectedId: string | null = null;
  private resizeObserver: ResizeObserver;

  constructor(private el: HTMLCanvasElement, private onSelect: (v: VNode | null) => void) {
    this.canvas = new LGraphCanvas(el, this.graph, { skip_render: false } as never);
    this.canvas.allow_searchbox = false;
    this.canvas.show_info = false;
    this.canvas.background_image = '';
    this.canvas.render_canvas_border = false;
    this.canvas.links_render_mode = LiteGraph.SPLINE_LINK;
    this.canvas.connections_width = 2;
    this.canvas.default_connection_color_byType = { flow: '#7C8A98' };
    this.canvas.default_connection_color_byTypeOff = { flow: '#7C8A98' };
    (this.canvas as unknown as { clear_background_color: string }).clear_background_color = '#F3F5F7';
    this.canvas.onSelectionChange = (selected) => {
      if (this.rebuilding) return;
      const first = Object.values(selected ?? {})[0] as StepNode | undefined;
      this.selectedId = first?.v?.id ?? null;
      this.onSelect(first?.v ?? null);
    };
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(el.parentElement!);
    this.resize();
  }

  resize() {
    const parent = this.el.parentElement!;
    const w = Math.max(1, parent.clientWidth);
    const h = Math.max(1, parent.clientHeight);
    this.el.style.width = `${w}px`;
    this.el.style.height = `${h}px`;
    this.canvas.resize(w, h);   // also resizes the background layer
    this.canvas.setDirty(true, true);
  }

  // ---------- public API ----------

  /** Replaces everything with a fresh graph (a different workflow, or the first load). */
  reset(g: VGraph, opts: { fit: boolean }) {
    this.finishTweens();
    this.auto.clear();
    this.selectedId = null;
    this.rebuild(g, { animate: false, flash: new Set() });
    if (opts.fit) this.fit();
    if (g.status === 'RUNNING') this.focusActive();
  }

  /**
   * Applies a change set.  State-only changes edit the existing nodes in place; new steps or
   * links rebuild the graph but keep every node where it is and slide new ones out of their parents.
   */
  update(g: VGraph, diff: GraphDiff) {
    const touched = new Set([...diff.changedNodes.map((c) => c.next.id), ...diff.addedNodes.map((n) => n.id)]);
    if (isStructural(diff)) {
      this.rebuild(g, { animate: true, flash: touched });
    } else {
      for (const c of diff.changedNodes) {
        const node = this.nodes.get(c.next.id);
        if (!node) continue;
        node.v = c.next;
        this.paint(node);
        this.flash(node);
      }
    }
    this.startLoop();
    this.canvas.setDirty(true, true);
  }

  /** Fits the whole graph, but never below a zoom where node text stays readable. */
  fit() {
    const all = [...this.nodes.values()];
    if (!all.length) return;
    const pad = 40;
    const x0 = Math.min(...all.map((n) => n.pos[0])) - pad;
    const y0 = Math.min(...all.map((n) => n.pos[1] - TITLE_H)) - pad;
    const x1 = Math.max(...all.map((n) => n.pos[0] + n.size[0])) + pad;
    const y1 = Math.max(...all.map((n) => n.pos[1] + n.size[1])) + pad;
    const vw = this.el.clientWidth || 1;
    const vh = this.el.clientHeight || 1;
    const scale = Math.min(1, Math.max(MIN_READABLE_ZOOM, Math.min(vw / (x1 - x0), vh / (y1 - y0))));
    const ds = this.canvas.ds;
    ds.scale = scale;
    // screen = (graph + offset) * scale: keep the start of the workflow in view, centred vertically
    const fitsWidth = (x1 - x0) * scale <= vw;
    ds.offset = [
      fitsWidth ? (vw / scale - (x1 - x0)) / 2 - x0 : 24 / scale - x0,
      (vh / scale - (y1 - y0)) / 2 - y0,
    ];
    this.canvas.setDirty(true, true);
  }

  /** Centres the view on the first step that is still in flight. */
  focusActive() {
    const active = [...this.nodes.values()].find((n) => n.v && ['running', 'retrying', 'scheduled'].includes(n.v.state));
    if (active) this.canvas.centerOnNode(active);
  }

  /** Brings a node into view without changing the zoom, if it is not already visible. */
  revealIfOffscreen(id: string) {
    const node = this.nodes.get(id);
    if (!node) return;
    const { scale, offset } = this.canvas.ds;
    const sx = (node.pos[0] + offset[0]) * scale;
    const sy = (node.pos[1] + offset[1]) * scale;
    const margin = 40;
    const visible = sx > margin && sy > margin
      && sx + node.size[0] * scale < this.el.clientWidth - margin
      && sy + node.size[1] * scale < this.el.clientHeight - margin;
    if (!visible) this.canvas.centerOnNode(node);
  }

  clear() {
    this.finishTweens();
    this.graph.clear();
    this.nodes.clear();
    this.auto.clear();
    this.canvas.setDirty(true, true);
  }

  // ---------- internals ----------

  private paint(node: StepNode) {
    const v = node.v!;
    node.title = v.label;
    node.color = STATE_COLOR[v.state].solid;
    node.bgcolor = STATE_COLOR[v.state].tint;
    node.boxcolor = STATE_COLOR[v.state].solid;
    node.shape = v.kind === 'start' || v.kind === 'end' ? RenderShape.CARD
      : v.kind === 'signal' || v.kind === 'update' ? RenderShape.BOX : RenderShape.ROUND;
  }

  private flash(node: StepNode) {
    node.flashUntil = performance.now() + FLASH_MS;
  }

  private rebuild(g: VGraph, o: { animate: boolean; flash: Set<string> }) {
    this.finishTweens();
    const old = new Map(this.nodes);
    const oldAuto = new Map(this.auto);
    const placed = layoutGraph(g);
    const parentOf = new Map<string, string>();
    for (const e of g.edges) if (!parentOf.has(e.to)) parentOf.set(e.to, e.from);

    this.rebuilding = true;
    this.graph.clear();
    this.nodes.clear();
    this.auto.clear();

    for (const v of g.nodes) {
      const p = placed.get(v.id)!;
      const layoutPos: Pos = [p.x, p.y + TITLE_H];
      const node = LiteGraph.createNode('temporal/step') as StepNode;
      node.v = v;
      this.paint(node);
      for (let i = 0; i < p.inputs; i++) node.addInput('', 'flow');
      if (v.kind !== 'end') node.addOutput('', 'flow');
      node.setSize([p.w, p.h]);

      const before = old.get(v.id);
      let target = layoutPos;
      let start: Pos = layoutPos;
      let autoPos = layoutPos;
      if (before) {
        const prevAuto = oldAuto.get(v.id) ?? before.pos as Pos;
        const moved = Math.abs(before.pos[0] - prevAuto[0]) > 0.5 || Math.abs(before.pos[1] - prevAuto[1]) > 0.5;
        start = [before.pos[0], before.pos[1]];
        if (moved) { target = [before.pos[0], before.pos[1]]; autoPos = prevAuto; }
      } else if (o.animate) {
        const from = old.get(parentOf.get(v.id) ?? '');
        if (from) start = [from.pos[0], from.pos[1]];
      }
      node.pos = [start[0], start[1]];
      this.graph.add(node);
      this.nodes.set(v.id, node);
      this.auto.set(v.id, autoPos);
      if (o.flash.has(v.id)) this.flash(node);
      if (o.animate && !reduceMotion() && (start[0] !== target[0] || start[1] !== target[1])) {
        this.tweens.push({ node, from: [start[0], start[1]], to: target, t0: performance.now() });
      } else node.pos = [target[0], target[1]];
    }

    const used = new Map<string, number>();
    for (const e of g.edges) {
      const from = this.nodes.get(e.from);
      const to = this.nodes.get(e.to);
      if (!from || !to) continue;
      const slot = used.get(e.to) ?? 0;
      used.set(e.to, slot + 1);
      from.connect(0, to, slot);
    }

    const keep = this.selectedId ? this.nodes.get(this.selectedId) : undefined;
    if (keep) this.canvas.selectItems([keep]);
    this.rebuilding = false;
    this.startLoop();
    this.canvas.setDirty(true, true);
  }

  private finishTweens() {
    for (const t of this.tweens) t.node.pos = [t.to[0], t.to[1]];
    this.tweens = [];
  }

  /** Runs only while something is animating (slides or highlights), then goes idle. */
  private startLoop() {
    if (this.raf) return;
    const tick = (now: number) => {
      this.raf = 0;
      this.tweens = this.tweens.filter((t) => {
        const p = Math.min(1, (now - t.t0) / TWEEN_MS);
        const e = 1 - (1 - p) ** 3;
        t.node.pos = [t.from[0] + (t.to[0] - t.from[0]) * e, t.from[1] + (t.to[1] - t.from[1]) * e];
        return p < 1;
      });
      const flashing = [...this.nodes.values()].some((n) => n.flashUntil > now);
      this.canvas.setDirty(true, true);
      if (this.tweens.length || flashing) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
}
