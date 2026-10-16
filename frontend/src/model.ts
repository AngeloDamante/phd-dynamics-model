// Diagram document model, mirroring backend/simnode/io/diagram.py.
// Pure data + pure helpers: no DOM, no JointJS.

export interface PortInfo {
  name: string;
  dtype: string | null;
}

export interface Ports {
  inputs: PortInfo[];
  outputs: PortInfo[];
}

export interface BlockDoc {
  id: string;
  name: string;
  type: string;
  params: Record<string, any>;
  x: number;
  y: number;
  /** UI cache of the block's ports; the backend recomputes them. */
  ports: Ports;
  system?: SystemDoc;
}

export interface WireEnd {
  block: string;
  port: string;
}

export interface WireDoc {
  id: string;
  src: WireEnd;
  dst: WireEnd;
  vertices?: { x: number; y: number }[];
  /** Stream this signal to the Data Inspector. */
  monitor?: boolean;
}

export interface SystemDoc {
  blocks: BlockDoc[];
  wires: WireDoc[];
}

export interface SimSettings {
  stop_time: number;
  base_step: number | null;
  realtime: boolean;
  speed: number;
}

export interface DiagramDoc {
  format: 'simnode-diagram';
  version: 1;
  name: string;
  sim: SimSettings;
  root: SystemDoc;
}

export function emptyDiagram(name = 'untitled'): DiagramDoc {
  return {
    format: 'simnode-diagram',
    version: 1,
    name,
    sim: { stop_time: 10, base_step: null, realtime: false, speed: 1 },
    root: { blocks: [], wires: [] },
  };
}

export function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function clone<T>(x: T): T {
  return structuredClone(x);
}

/** Return `base` or `base<N>` so that no block in `sys` has that name. */
export function uniqueName(sys: SystemDoc, base: string, exceptId?: string): string {
  const taken = new Set(sys.blocks.filter((b) => b.id !== exceptId).map((b) => b.name));
  if (!taken.has(base)) return base;
  const stem = base.replace(/\d+$/, '');
  for (let i = 1; ; i++) if (!taken.has(`${stem}${i}`)) return `${stem}${i}`;
}

export function isIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !PY_KEYWORDS.has(name);
}

const PY_KEYWORDS = new Set(
  ('False None True and as assert async await break class continue def del elif else except ' +
    'finally for from global if import in is lambda nonlocal not or pass raise return try ' +
    'while with yield').split(' '),
);

/** Ports of a subsystem: its Inport/Outport blocks, in order. */
export function subsystemPorts(sys: SystemDoc): Ports {
  const port = (b: BlockDoc): PortInfo => ({ name: b.name, dtype: b.params.dtype ?? null });
  return {
    inputs: sys.blocks.filter((b) => b.type === 'Inport').map(port),
    outputs: sys.blocks.filter((b) => b.type === 'Outport').map(port),
  };
}

/** Drop wires whose ends no longer exist (block or port removed). */
export function pruneWires(sys: SystemDoc): void {
  const byId = new Map(sys.blocks.map((b) => [b.id, b]));
  sys.wires = sys.wires.filter((w) => {
    const s = byId.get(w.src.block);
    const d = byId.get(w.dst.block);
    return (
      !!s && !!d &&
      s.ports.outputs.some((p) => p.name === w.src.port) &&
      d.ports.inputs.some((p) => p.name === w.dst.port)
    );
  });
}

/** Recompute ports of every subsystem bottom-up and prune broken wires. */
export function refreshSubsystems(sys: SystemDoc): void {
  for (const b of sys.blocks) {
    if (b.type === 'Subsystem' && b.system) {
      refreshSubsystems(b.system);
      b.ports = subsystemPorts(b.system);
    }
  }
  pruneWires(sys);
}

/** Walk a path of block ids from the root; returns the systems along the way. */
export function resolvePath(root: SystemDoc, path: string[]): { sys: SystemDoc; names: string[] } {
  let sys = root;
  const names: string[] = [];
  for (const id of path) {
    const b = sys.blocks.find((x) => x.id === id);
    if (!b || !b.system) break;
    names.push(b.name);
    sys = b.system;
  }
  return { sys, names };
}

/**
 * Move the blocks `ids` of `sys` into a new subsystem, creating Inport/
 * Outport blocks for every wire crossing the selection boundary.
 * Returns the new subsystem block.
 */
export function groupIntoSubsystem(sys: SystemDoc, ids: Set<string>): BlockDoc {
  const inside = sys.blocks.filter((b) => ids.has(b.id));
  const byId = new Map(sys.blocks.map((b) => [b.id, b]));
  const minX = Math.min(...inside.map((b) => b.x));
  const minY = Math.min(...inside.map((b) => b.y));
  const maxY = Math.max(...inside.map((b) => b.y));
  const inner: SystemDoc = { blocks: [], wires: [] };
  for (const b of inside) inner.blocks.push({ ...b, x: b.x - minX + 200, y: b.y - minY + 80 });

  const outerWires: WireDoc[] = [];
  const keep: WireDoc[] = [];
  const incoming = new Map<string, WireDoc[]>();
  const outgoing = new Map<string, WireDoc[]>();
  for (const w of sys.wires) {
    const sIn = ids.has(w.src.block);
    const dIn = ids.has(w.dst.block);
    if (sIn && dIn) inner.wires.push(w);
    else if (!sIn && dIn) push(incoming, `${w.src.block}.${w.src.port}`, w);
    else if (sIn && !dIn) push(outgoing, `${w.src.block}.${w.src.port}`, w);
    else keep.push(w);
  }

  const sub: BlockDoc = {
    id: newId('b'),
    name: uniqueName(sys, 'Subsystem'),
    type: 'Subsystem',
    params: {},
    x: minX,
    y: Math.round((minY + maxY) / 2 / 10) * 10,
    ports: { inputs: [], outputs: [] },
    system: inner,
  };

  // Order boundary ports like the ports they connect to (top to bottom), so
  // the new subsystem's wires don't cross needlessly.
  const dstRank = (ws: WireDoc[]) => Math.min(...ws.map((w) => {
    const d = byId.get(w.dst.block)!;
    return d.y * 1000 + d.ports.inputs.findIndex((p) => p.name === w.dst.port);
  }));
  const srcRank = (ws: WireDoc[]) => {
    const s = byId.get(ws[0].src.block)!;
    return s.y * 1000 + s.ports.outputs.findIndex((p) => p.name === ws[0].src.port);
  };
  const inGroups = [...incoming.values()].sort((a, b) => dstRank(a) - dstRank(b));
  inGroups.forEach((ws, i) => {
    const port = boundaryBlock(inner, 'Inport', `In${i + 1}`, 60, 80 + i * 70);
    for (const w of ws) {
      inner.wires.push({ id: newId('w'), src: { block: port.id, port: 'y' }, dst: w.dst });
    }
    outerWires.push({ id: newId('w'), src: ws[0].src, dst: { block: sub.id, port: port.name },
                      monitor: ws.some((w) => w.monitor) });
  });
  const outGroups = [...outgoing.values()].sort((a, b) => dstRank(a) - dstRank(b) || srcRank(a) - srcRank(b));
  const rightX = Math.max(...inner.blocks.map((b) => b.x)) + 220;
  outGroups.forEach((ws, i) => {
    const port = boundaryBlock(inner, 'Outport', `Out${i + 1}`, rightX, 80 + i * 70);
    inner.wires.push({ id: newId('w'), src: ws[0].src, dst: { block: port.id, port: 'u' },
                       monitor: ws.some((w) => w.monitor) });
    for (const w of ws) {
      outerWires.push({ id: newId('w'), src: { block: sub.id, port: port.name }, dst: w.dst });
    }
  });

  sub.ports = subsystemPorts(inner);
  sys.blocks = sys.blocks.filter((b) => !ids.has(b.id));
  sys.blocks.push(sub);
  sys.wires = [...keep, ...outerWires];
  return sub;
}

function boundaryBlock(sys: SystemDoc, type: 'Inport' | 'Outport', name: string,
                       x: number, y: number): BlockDoc {
  const b: BlockDoc = {
    id: newId('b'),
    name: uniqueName(sys, name),
    type,
    params: { dtype: null, default: null },
    x,
    y,
    ports: type === 'Inport'
      ? { inputs: [], outputs: [{ name: 'y', dtype: null }] }
      : { inputs: [{ name: 'u', dtype: null }], outputs: [] },
  };
  sys.blocks.push(b);
  return b;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

/** Endpoint key `"a/b/c.port"` as used by the backend runner. */
export function endpointKey(names: string[], block: string, port: string): string {
  return `${[...names, block].join('/')}.${port}`;
}

/** Every monitored wire in the diagram, as endpoint keys of its source. */
export function monitoredEndpoints(root: SystemDoc): string[] {
  const out: string[] = [];
  const walk = (sys: SystemDoc, names: string[]) => {
    const byId = new Map(sys.blocks.map((b) => [b.id, b]));
    for (const w of sys.wires) {
      if (w.monitor) out.push(endpointKey(names, byId.get(w.src.block)!.name, w.src.port));
    }
    for (const b of sys.blocks) if (b.system) walk(b.system, [...names, b.name]);
  };
  walk(root, []);
  return out;
}
