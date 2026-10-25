import type { NodeKind, VGraph } from './history';

const GAP_X = 84;
const GAP_Y = 30;

export interface Size { w: number; h: number; /** space the label needs under the shape */ below: number; /** extra outline drawn outside the shape */ margin: number }

/** Footprint of each node kind: events are small circles, tasks are wide, signals are short. */
export function sizeOf(kind: NodeKind, inputs: number): Size {
  switch (kind) {
    case 'start':
    case 'end':
      return { w: 44, h: 44, below: 48, margin: 0 };
    case 'timer':
      return { w: 44, h: 44, below: 36, margin: 0 };
    case 'signal':
    case 'update':
      return { w: 168, h: 40, below: 0, margin: 0 };
    case 'child':
      return { w: 232, h: Math.max(64, 16 + 16 * inputs), below: 0, margin: 6 };
    default:
      return { w: 232, h: Math.max(64, 16 + 16 * inputs), below: 0, margin: 0 };
  }
}

/** Y of the i-th of n link ports along the left edge of a node of height h. */
export const portY = (h: number, n: number, i: number) => (h * (i + 1)) / (n + 1);

export interface Placement { x: number; y: number; w: number; h: number; inputs: number; size: Size }

/** Left-to-right layered layout: column = longest path from the start. */
export function layoutGraph(g: VGraph): Map<string, Placement> {
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const n of g.nodes) { parents.set(n.id, []); children.set(n.id, []); }
  for (const e of g.edges) { parents.get(e.to)?.push(e.from); children.get(e.from)?.push(e.to); }

  // Nodes are created after everything they depend on, so creation order is a topological order.
  const layer = new Map<string, number>();
  for (const n of g.nodes) {
    const ps = parents.get(n.id)!;
    layer.set(n.id, ps.length ? Math.max(...ps.map((p) => layer.get(p) ?? 0)) + 1 : 0);
  }
  // Signals and updates have no parents: park them one column before their first consumer.
  for (const n of g.nodes) {
    if (n.kind !== 'signal' && n.kind !== 'update') continue;
    const kids = children.get(n.id)!;
    if (kids.length) layer.set(n.id, Math.max(0, Math.min(...kids.map((k) => layer.get(k)!)) - 1));
  }

  const kindOf = new Map(g.nodes.map((n) => [n.id, n.kind]));
  const sizes = new Map<string, Size>();
  for (const n of g.nodes) sizes.set(n.id, sizeOf(n.kind, parents.get(n.id)!.length));

  const columns = new Map<number, string[]>();
  for (const n of g.nodes) {
    const l = layer.get(n.id)!;
    (columns.get(l) ?? columns.set(l, []).get(l)!).push(n.id);
  }
  const order = [...columns.keys()].sort((a, b) => a - b);

  // Column x: each column is as wide as its widest node; narrower nodes are centred in it.
  const colX = new Map<number, number>();
  const colW = new Map<number, number>();
  let x = 0;
  for (const l of order) {
    const w = Math.max(...columns.get(l)!.map((id) => sizes.get(id)!.w));
    colX.set(l, x); colW.set(l, w);
    x += w + GAP_X;
  }

  const out = new Map<string, Placement>();
  const centerY = new Map<string, number>();
  const cell = (id: string) => { const s = sizes.get(id)!; return s.h + s.below + s.margin * 2; };

  for (const l of order) {
    const ids = columns.get(l)!;
    const bary = (id: string) => {
      const ps = parents.get(id)!.filter((p) => centerY.has(p));
      return ps.length ? ps.reduce((s, p) => s + centerY.get(p)!, 0) / ps.length : Number.POSITIVE_INFINITY;
    };
    const idx = new Map(ids.map((id, i) => [id, i]));
    ids.sort((a, b) => {
      const d = bary(a) - bary(b);
      return Number.isNaN(d) || d === 0 ? idx.get(a)! - idx.get(b)! : d;
    });
    const total = ids.reduce((s, id) => s + cell(id), 0) + GAP_Y * (ids.length - 1);
    let y = -total / 2;
    for (const id of ids) {
      const s = sizes.get(id)!;
      const top = y + s.margin;
      out.set(id, {
        x: colX.get(l)! + (colW.get(l)! - s.w) / 2, y: top, w: s.w, h: s.h,
        inputs: parents.get(id)!.length, size: s,
      });
      centerY.set(id, top + s.h / 2);
      y += cell(id) + GAP_Y;
    }
  }
  void kindOf;
  return out;
}
