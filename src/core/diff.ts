import { canon, type VEdge, type VGraph, type VNode } from './history';

export interface NodeChange { prev: VNode; next: VNode; fields: string[] }

export interface GraphDiff {
  addedNodes: VNode[];
  removedNodes: VNode[];
  changedNodes: NodeChange[];
  addedEdges: VEdge[];
  removedEdges: VEdge[];
  status?: { from: string; to: string };
  newWarnings: string[];
}

const FIELDS = ['label', 'state', 'attempt', 'maxAttempts', 'failure', 'startedAt', 'closedAt', 'durationMs', 'result'] as const;
const edgeKey = (e: VEdge) => `${e.from}>${e.to}`;

export function diffGraphs(prev: VGraph | null, next: VGraph): GraphDiff {
  const prevNodes = new Map((prev?.nodes ?? []).map((n) => [n.id, n]));
  const nextNodes = new Map(next.nodes.map((n) => [n.id, n]));
  const changedNodes: NodeChange[] = [];
  for (const n of next.nodes) {
    const p = prevNodes.get(n.id);
    if (!p) continue;
    const fields: string[] = FIELDS.filter((f) => p[f] !== n[f]);
    if (p.events.length !== n.events.length) fields.push('events');
    if (fields.length) changedNodes.push({ prev: p, next: n, fields });
  }
  const prevEdges = new Set((prev?.edges ?? []).map(edgeKey));
  const nextEdges = new Set(next.edges.map(edgeKey));
  const prevWarn = new Set(prev?.warnings ?? []);
  return {
    addedNodes: next.nodes.filter((n) => !prevNodes.has(n.id)),
    removedNodes: (prev?.nodes ?? []).filter((n) => !nextNodes.has(n.id)),
    changedNodes,
    addedEdges: next.edges.filter((e) => !prevEdges.has(edgeKey(e))),
    removedEdges: (prev?.edges ?? []).filter((e) => !nextEdges.has(edgeKey(e))),
    status: prev && prev.status !== next.status ? { from: prev.status, to: next.status } : undefined,
    newWarnings: next.warnings.filter((w) => !prevWarn.has(w)),
  };
}

export const isStructural = (d: GraphDiff) =>
  d.addedNodes.length + d.removedNodes.length + d.addedEdges.length + d.removedEdges.length > 0;

export const isEmpty = (d: GraphDiff) =>
  !isStructural(d) && d.changedNodes.length === 0 && !d.status && d.newWarnings.length === 0;

const stateWord = (s: string) => s.replace(/([A-Z])/g, ' $1').toLowerCase();

/** One human-readable line per change, for the activity log. */
export function summarize(d: GraphDiff): string[] {
  const out: string[] = [];
  for (const n of d.addedNodes) {
    if (n.kind !== 'start') out.push(`${n.label} ${n.kind === 'signal' ? 'received' : n.kind === 'end' ? '' : 'scheduled'}`.trim());
  }
  for (const c of d.changedNodes) {
    if (c.fields.includes('state')) out.push(`${c.next.label}: ${stateWord(c.prev.state)} → ${stateWord(c.next.state)}`);
    else if (c.fields.includes('attempt')) out.push(`${c.next.label}: attempt ${c.next.attempt}`);
  }
  for (const w of d.newWarnings) out.push(w);
  if (d.status) out.push(`Workflow ${canon(d.status).toLowerCase().replaceAll('_', ' ')}`);
  return out;
}
