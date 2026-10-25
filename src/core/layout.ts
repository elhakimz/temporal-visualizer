import type { VGraph } from './history';

export const NODE_W = 232;
export const BASE_H = 64;
const SLOT_ROW = 20;
const GAP_X = 96;
const GAP_Y = 58; // includes the 30px title bar LiteGraph draws above each node

export interface Placement { x: number; y: number; w: number; h: number; inputs: number }

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

  const columns = new Map<number, string[]>();
  for (const n of g.nodes) {
    const l = layer.get(n.id)!;
    (columns.get(l) ?? columns.set(l, []).get(l)!).push(n.id);
  }

  const out = new Map<string, Placement>();
  const heightOf = (id: string) => Math.max(BASE_H, 22 + SLOT_ROW * Math.max(1, parents.get(id)!.length));
  const centerY = new Map<string, number>();

  for (const l of [...columns.keys()].sort((a, b) => a - b)) {
    const ids = columns.get(l)!;
    const bary = (id: string) => {
      const ps = parents.get(id)!.filter((p) => centerY.has(p));
      return ps.length ? ps.reduce((s, p) => s + centerY.get(p)!, 0) / ps.length : Number.POSITIVE_INFINITY;
    };
    const order = new Map(ids.map((id, i) => [id, i]));
    ids.sort((a, b) => {
      const d = bary(a) - bary(b);
      return Number.isNaN(d) || d === 0 ? order.get(a)! - order.get(b)! : d;
    });
    const total = ids.reduce((s, id) => s + heightOf(id), 0) + GAP_Y * (ids.length - 1);
    let y = -total / 2;
    for (const id of ids) {
      const h = heightOf(id);
      out.set(id, { x: l * (NODE_W + GAP_X), y, w: NODE_W, h, inputs: parents.get(id)!.length });
      centerY.set(id, y + h / 2);
      y += h + GAP_Y;
    }
  }
  return out;
}
