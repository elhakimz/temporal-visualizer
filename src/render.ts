import { LGraph, LGraphCanvas, LGraphNode, LinkMarkerShape, LiteGraph, RenderShape, TitleMode } from '@comfyorg/litegraph';
import '@comfyorg/litegraph/style.css';
import type { NodeKind, NodeState, VGraph, VNode } from './core/history';
import { isStructural, type GraphDiff } from './core/diff';
import { layoutGraph, portY } from './core/layout';

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
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

const INK = '#17222C';
const MUTED = '#56626E';
const LINK = '#7C8A98';
const CLEAR = 'rgba(0,0,0,0)';
const font = (weight: number | string, size: number) =>
  `${weight} ${size}px "IBM Plex Sans", "Segoe UI", system-ui, sans-serif`;

/**
 * Outline of a node, grown outwards by `grow` px.
 *  - start, end, timer: circles (events)
 *  - signal, update:    rectangle with rounded corners on the right only
 *  - everything else:   rounded rectangle (task)
 */
function shapePath(ctx: CanvasRenderingContext2D, kind: NodeKind, w: number, h: number, grow = 0) {
  const x = -grow, y = -grow, ww = w + grow * 2, hh = h + grow * 2;
  ctx.beginPath();
  if (kind === 'start' || kind === 'end' || kind === 'timer') {
    ctx.arc(w / 2, h / 2, w / 2 + grow, 0, Math.PI * 2);
  } else if (kind === 'signal' || kind === 'update') {
    const r = Math.min(16 + grow, hh / 2);
    ctx.moveTo(x, y);
    ctx.lineTo(x + ww - r, y);
    ctx.arcTo(x + ww, y, x + ww, y + r, r);
    ctx.lineTo(x + ww, y + hh - r);
    ctx.arcTo(x + ww, y + hh, x + ww - r, y + hh, r);
    ctx.lineTo(x, y + hh);
    ctx.closePath();
  } else {
    ctx.roundRect(x, y, ww, hh, 10 + grow);
  }
}

class StepNode extends LGraphNode {
  /** No title bar: the shape itself is the node (set per class in LiteGraph). */
  static title_mode = TitleMode.NO_TITLE;
  v?: VNode;
  flashUntil = 0;

  constructor(title = 'Step') {
    super(title);
    this.serialize_widgets = false;
    this.strokeStyles.selected = () => undefined;   // selection is drawn along the real outline below
  }

  /** The shape: filled with the state tint, outlined in the state colour. */
  onDrawBackground(ctx: CanvasRenderingContext2D): void {
    const v = this.v;
    if (!v) return;
    const [w, h] = this.size;
    const { solid, tint } = STATE_COLOR[v.state];
    const active = v.state === 'running' || v.state === 'retrying';

    ctx.save();
    shapePath(ctx, v.kind, w, h);
    ctx.fillStyle = tint;
    ctx.fill();
    ctx.lineJoin = 'round';
    ctx.strokeStyle = solid;
    ctx.lineWidth = v.kind === 'end' ? 4.5 : v.kind === 'start' ? 1.6 : active ? 3 : 2;
    if (v.kind === 'localActivity') ctx.setLineDash([7, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    if (v.kind === 'child') {                  // sub-workflow: the task, wrapped in a second outline
      shapePath(ctx, v.kind, w, h, 5);
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
    if (v.kind === 'timer') {                  // intermediate event: inner ring and a clock
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, w / 2 - 4.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(w / 2, h / 2 - 9); ctx.lineTo(w / 2, h / 2); ctx.lineTo(w / 2 + 6, h / 2 + 3.5);
      ctx.stroke();
    }
    if (this.selected) {
      shapePath(ctx, v.kind, w, h, v.kind === 'child' ? 10 : 6);
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = '#2F63C8';
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Text, and the fading outline that marks a state change. */
  onDrawForeground(ctx: CanvasRenderingContext2D): void {
    const v = this.v;
    if (!v || this.flags.collapsed) return;
    const [w, h] = this.size;
    const { solid } = STATE_COLOR[v.state];
    const bad = STATE_COLOR.failed.solid;
    const cx = w / 2;

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const line = statusLine(v);
    const shortFail = v.failure && (v.state === 'failed' || v.state === 'timedOut' || v.state === 'retrying' || v.kind === 'end');

    if (v.kind === 'signal' || v.kind === 'update') {
      ctx.font = font(600, 12);
      ctx.fillStyle = INK;
      ctx.fillText(fit(ctx, v.label, w - 30), cx - 4, h / 2 + 4.5);
    } else if (v.kind === 'start' || v.kind === 'end' || v.kind === 'timer') {
      let y = h + 17;
      ctx.font = font(600, 12);
      ctx.fillStyle = v.kind === 'end' ? solid : INK;
      ctx.fillText(fit(ctx, v.label, 190), cx, y);
      const sub = v.kind === 'end' ? (v.durationMs != null ? `after ${formatDuration(v.durationMs)}` : '') : v.kind === 'timer' ? line : '';
      if (sub) { y += 15; ctx.font = font(500, 11); ctx.fillStyle = v.kind === 'timer' ? solid : MUTED; ctx.fillText(fit(ctx, sub, 190), cx, y); }
      if (shortFail) { y += 14; ctx.font = font(400, 11); ctx.fillStyle = bad; ctx.fillText(fit(ctx, v.failure!, 230), cx, y); }
    } else {
      ctx.font = font(600, 13);
      ctx.fillStyle = INK;
      ctx.fillText(fit(ctx, v.label, w - 36), cx, 25);
      if (line) { ctx.font = font(600, 12); ctx.fillStyle = solid; ctx.fillText(fit(ctx, line, w - 36), cx, 43); }
      if (shortFail) { ctx.font = font(400, 11); ctx.fillStyle = bad; ctx.fillText(fit(ctx, v.failure!, w - 36), cx, 58); }
    }

    // A state change outlines the shape and fades out.
    const left = this.flashUntil - performance.now();
    if (left > 0) {
      ctx.globalAlpha = Math.min(1, left / FLASH_MS);
      shapePath(ctx, v.kind, w, h, v.kind === 'child' ? 11 : 7);
      ctx.strokeStyle = solid;
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    ctx.restore();
  }
}

LiteGraph.registerNodeType('temporal/step', StepNode);
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
  /** While scrubbing, every moment is laid out like the final graph so nodes do not shuffle between steps. */
  private pinned: Map<string, { x: number; cy: number }> | null = null;
  private selectedId: string | null = null;
  /** Called when a node is double-clicked (the page opens child workflows and next runs this way). */
  onNodeDblClick?: (v: VNode) => void;
  private resizeObserver: ResizeObserver;

  constructor(private el: HTMLCanvasElement, private onSelect: (v: VNode | null) => void) {
    this.canvas = new LGraphCanvas(el, this.graph, { skip_render: false } as never);
    this.canvas.allow_searchbox = false;
    this.canvas.show_info = false;
    this.canvas.background_image = '';
    this.canvas.render_canvas_border = false;
    this.canvas.links_render_mode = LiteGraph.STRAIGHT_LINK;
    this.canvas.connections_width = 2;
    this.canvas.render_connections_border = false;   // plain lines, like sequence flows
    this.canvas.render_connections_shadows = false;
    this.canvas.linkMarkerShape = LinkMarkerShape.None;
    this.canvas.default_connection_color_byType = { flow: '#7C8A98' };
    this.canvas.default_connection_color_byTypeOff = { flow: '#7C8A98' };
    (this.canvas as unknown as { clear_background_color: string }).clear_background_color = '#F3F5F7';
    // LiteGraph paints links of the selected node pure white, which vanishes on a light canvas.
    // Skip that highlight and tint those links with the accent colour instead (see paintLinks).
    const drawConnections = this.canvas.drawConnections.bind(this.canvas);
    this.canvas.drawConnections = (ctx: CanvasRenderingContext2D) => {
      const saved = this.canvas.highlighted_links;
      this.canvas.highlighted_links = {};
      try { drawConnections(ctx); } finally { this.canvas.highlighted_links = saved; }
    };
    this.canvas.onSelectionChange = (selected) => {
      if (this.rebuilding) return;
      const first = Object.values(selected ?? {})[0] as StepNode | undefined;
      this.selectedId = first?.v?.id ?? null;
      this.paintLinks();
      this.onSelect(first?.v ?? null);
    };
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(el.parentElement!);
    this.resize();
  }

  private lastSize: [number, number] | null = null;

  resize() {
    const parent = this.el.parentElement!;
    const w = Math.max(1, parent.clientWidth);
    const h = Math.max(1, parent.clientHeight);
    // Keep whatever is in the middle of the view in the middle when the canvas changes size
    // (replay bar appearing, sidebar dragged or collapsed), so a step you just jumped to stays centred.
    if (this.lastSize && this.nodes.size && (this.lastSize[0] !== w || this.lastSize[1] !== h)) {
      const ds = this.canvas.ds, k = ds.scale;
      const gx = this.lastSize[0] / 2 / k - ds.offset[0], gy = this.lastSize[1] / 2 / k - ds.offset[1];
      ds.offset = [w / 2 / k - gx, h / 2 / k - gy];
    }
    this.lastSize = [w, h];
    this.el.style.width = `${w}px`;
    this.el.style.height = `${h}px`;
    this.canvas.resize(w, h);   // also resizes the background layer
    this.canvas.setDirty(true, true);
  }

  // ---------- public API ----------

  /** Pass the final graph to keep node positions stable while stepping through a run; null releases it. */
  pinLayout(g: VGraph | null) {
    this.pinned = g ? new Map([...layoutGraph(g)].map(([id, p]) => [id, { x: p.x, cy: p.y + p.h / 2 }])) : null;
  }

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
    const y0 = Math.min(...all.map((n) => n.pos[1])) - pad;
    const x1 = Math.max(...all.map((n) => n.pos[0] + n.size[0])) + pad;
    const y1 = Math.max(...all.map((n) => n.pos[1] + n.size[1])) + pad + 44;   // room for labels under event circles
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

  /** Selects a node, centres the view on it and outlines it; false if the node is not in the graph. */
  focusNode(id: string): boolean {
    const node = this.nodes.get(id);
    if (!node) return false;
    this.selectedId = id;
    this.canvas.selectItems([node]);
    this.paintLinks();
    this.canvas.centerOnNode(node);
    this.flash(node);
    this.startLoop();
    this.canvas.setDirty(true, true);
    this.onSelect(node.v ?? null);
    return true;
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
    // LiteGraph still fills a plain box behind the node; keep it invisible and draw the real shape ourselves.
    node.title = node.v!.label;
    node.color = CLEAR;
    node.bgcolor = CLEAR;
    node.boxcolor = CLEAR;
    node.shape = RenderShape.BOX;
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
      const pin = this.pinned?.get(v.id);
      const layoutPos: Pos = pin ? [pin.x, pin.cy - p.h / 2] : [p.x, p.y];
      const node = LiteGraph.createNode('temporal/step') as StepNode;
      node.v = v;
      node.onDblClick = () => { if (node.v) this.onNodeDblClick?.(node.v); };
      this.paint(node);
      // Links meet the outline: an arrowhead on the way in, nothing visible on the way out.
      for (let i = 0; i < p.inputs; i++) {
        node.addInput('', 'flow', { pos: [-2, portY(p.h, p.inputs, i)], shape: RenderShape.ARROW, color_on: LINK, color_off: LINK } as never);
      }
      if (v.kind !== 'end') node.addOutput('', 'flow', { pos: [p.w, p.h / 2], shape: RenderShape.GRID, color_on: CLEAR, color_off: CLEAR } as never);
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
    this.paintLinks();
    this.startLoop();
    this.canvas.setDirty(true, true);
  }

  /** Links touching the selected node are drawn in the accent colour. */
  private paintLinks() {
    const sel = this.selectedId ? this.nodes.get(this.selectedId) : undefined;
    for (const link of this.graph.links.values()) {
      (link as { color?: string }).color = sel && (link.origin_id === sel.id || link.target_id === sel.id) ? '#2F63C8' : undefined;
    }
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
