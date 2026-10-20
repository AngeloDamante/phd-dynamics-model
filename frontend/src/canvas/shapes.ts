// JointJS shapes: Simulink-like blocks and orthogonal wires with line hops.
import { dia, g, shapes } from '@joint/core';
import type { BlockDoc } from '../model';

const INK = '#1f1f1f';
const MUTED = '#52514e';
const FONT = 'Inter, "Segoe UI", system-ui, sans-serif';

export const SELECT_COLOR = '#2a78d6';
export const ERROR_COLOR = '#d03b3b';

const portGroup = (side: 'left' | 'right', magnet: boolean | 'passive'): dia.Element.PortGroup => ({
  position: { name: side },
  markup: [
    { tagName: 'circle', selector: 'hit' },
    { tagName: 'path', selector: 'arrow' },
  ],
  attrs: {
    // Large invisible hit area so ports are easy to grab.
    hit: { r: 8, fill: 'transparent', magnet, cursor: 'crosshair' },
    arrow: {
      d: side === 'left' ? 'M -7 -4 L 0 0 L -7 4' : 'M 0 -4 L 7 0 L 0 4',
      fill: 'none', stroke: INK, strokeWidth: 1.5, pointerEvents: 'none',
    },
  },
  label: {
    position: { name: 'inside', args: { offset: 6 } },
    markup: [{ tagName: 'text', selector: 'portLabel' }],
  },
});

export const Block = dia.Element.define(
  'sim.Block',
  {
    // Blocks sit above wires so an already-wired output port stays grabbable.
    z: 2,
    size: { width: 90, height: 50 },
    attrs: {
      body: {
        width: 'calc(w)', height: 'calc(h)', rx: 3, ry: 3,
        fill: '#ffffff', stroke: INK, strokeWidth: 1.5,
      },
      glyph: {
        x: 'calc(0.5*w)', y: 'calc(0.5*h)', textAnchor: 'middle', textVerticalAnchor: 'middle',
        fontSize: 14, fontFamily: FONT, fill: INK, pointerEvents: 'none',
      },
      badge: {
        x: 'calc(w-4)', y: 9, textAnchor: 'end', textVerticalAnchor: 'middle',
        fontSize: 9, fontFamily: FONT, fill: MUTED, pointerEvents: 'none',
      },
      name: {
        x: 'calc(0.5*w)', y: 'calc(h+13)', textAnchor: 'middle', textVerticalAnchor: 'middle',
        fontSize: 12, fontFamily: FONT, fill: INK,
      },
    },
    ports: {
      groups: {
        in: { ...portGroup('left', 'passive') },
        out: { ...portGroup('right', true) },
      },
    },
  },
  {
    markup: [
      { tagName: 'rect', selector: 'body' },
      { tagName: 'text', selector: 'glyph' },
      { tagName: 'text', selector: 'badge' },
      { tagName: 'text', selector: 'name' },
    ],
  },
);

export const cellNamespace = { ...shapes, sim: { Block } };

export const ROUTER = {
  name: 'manhattan' as const,
  args: { step: 10, padding: 14, startDirections: ['right'], endDirections: ['left'] },
};
/**
 * Router for a wire into input `portIndex` of `portCount`. Each input gets
 * its own approach column, so wires converging on one block never share a
 * segment (which would read as a branch of one signal). The top input gets
 * the outermost column: wires coming from sources stacked in port order
 * then reach their ports without crossing.
 */
export function routerFor(portIndex: number, portCount: number) {
  const rank = Math.max(0, portCount - 1 - Math.max(0, portIndex));
  return { ...ROUTER, args: { ...ROUTER.args, padding: 14 + 10 * rank } };
}

export const CONNECTOR = { name: 'jumpover' as const, args: { size: 5, jump: 'arc' as const } };

export function makeLink(): dia.Link {
  return new shapes.standard.Link({
    z: 1,
    router: ROUTER,
    connector: CONNECTOR,
    attrs: {
      line: {
        stroke: INK, strokeWidth: 1.5,
        targetMarker: { type: 'path', d: 'M 7 -3.5 L 0 0 L 7 3.5 z', fill: INK, stroke: INK },
      },
      wrapper: { strokeWidth: 12, cursor: 'pointer' },
    },
  });
}

/** Text shown inside a block. Display only; semantics live in the backend. */
function glyph(b: BlockDoc, siblings: BlockDoc[]): string {
  const p = b.params;
  switch (b.type) {
    case 'Constant': return String(p.value);
    case 'Gain': return `×${p.k}`;
    case 'Sum': return 'Σ';
    case 'Step': return '⎍';
    case 'Sine': return '∿';
    case 'UnitDelay': return '1/z';
    case 'Scope': return '📈';
    case 'PythonNode': return 'ƒ(x)';
    case 'Subsystem': return '';
    case 'Inport':
    case 'Outport':
      return String(siblings.filter((s) => s.type === b.type).indexOf(b) + 1);
    default: return b.type;
  }
}

function badge(b: BlockDoc): string {
  if (b.params.sample_time != null) return `Ts=${b.params.sample_time}`;
  if (b.type === 'PythonNode') return '⚡msg';
  return '';
}

function portLabel(b: BlockDoc, group: 'in' | 'out', name: string, i: number): string {
  if (b.type === 'Sum' && group === 'in') return String(b.params.signs ?? '')[i] ?? '';
  if (b.type === 'PythonNode' || b.type === 'Subsystem') return name;
  return '';
}

export function blockSize(b: BlockDoc): { width: number; height: number } {
  const n = Math.max(b.ports.inputs.length, b.ports.outputs.length, 1);
  if (b.type === 'PythonNode' || b.type === 'Subsystem') {
    return { width: 130, height: Math.max(60, n * 26 + 10) };
  }
  if (b.type === 'Inport' || b.type === 'Outport') return { width: 40, height: 26 };
  return { width: 70, height: Math.max(44, n * 22 + 6) };
}

/** Create or update the element showing `b`. */
export function renderBlock(el: dia.Element, b: BlockDoc, siblings: BlockDoc[]): void {
  el.position(b.x, b.y);
  el.resize(blockSize(b).width, blockSize(b).height);
  el.attr({
    glyph: { text: glyph(b, siblings) },
    badge: { text: badge(b) },
    name: { text: b.name },
    body: { rx: b.type === 'Inport' || b.type === 'Outport' ? 13 : 3 },
  });
  const ports = [
    ...b.ports.inputs.map((p, i) => ({
      id: `in:${p.name}`, group: 'in', attrs: { portLabel: {
        text: portLabel(b, 'in', p.name, i), fontSize: 10, fill: MUTED, fontFamily: FONT } },
    })),
    ...b.ports.outputs.map((p, i) => ({
      id: `out:${p.name}`, group: 'out', attrs: { portLabel: {
        text: portLabel(b, 'out', p.name, i), fontSize: 10, fill: MUTED, fontFamily: FONT } },
    })),
  ];
  const wanted = new Set(ports.map((p) => p.id));
  const stale = el.getPorts().filter((p) => !wanted.has(p.id!));
  if (stale.length) el.removePorts(stale);
  for (const p of ports) {
    if (el.hasPort(p.id)) el.portProp(p.id, 'attrs', p.attrs);
    else el.addPort(p);
  }
  // Keep port order equal to declaration order.
  const order = ports.map((p) => p.id);
  const current = el.getPorts().map((p) => p.id);
  if (current.join() !== order.join()) {
    el.removePorts(el.getPorts());
    el.addPorts(ports);
  }
}

// ------------------------------------------------------------ wire editing

type Pt = { x: number; y: number };

const STUB = 10;
const snap = (v: number) => Math.round(v / 10) * 10;
const near = (a: number, b: number) => Math.abs(a - b) < 0.5;

/**
 * Router for a wire whose route the user has edited: goes through the
 * stored vertices, adding an elbow wherever two consecutive points are not
 * aligned (e.g. after a block moved). The first leg leaves the source
 * horizontally and the last one enters the target horizontally.
 */
export function frozenRouter(vertices: dia.Point[], _args: unknown, view: dia.LinkView): g.Point[] {
  const pts: Pt[] = [view.sourceAnchor, ...vertices, view.targetAnchor];
  const out: Pt[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (!near(a.x, b.x) && !near(a.y, b.y)) {
      out.push(i === pts.length - 1 ? { x: a.x, y: b.y } : { x: b.x, y: a.y });
    }
    if (i < pts.length - 1) out.push(b);
  }
  return out.map((p) => new g.Point(p.x, p.y));
}

/** Drop duplicate and collinear points, keeping the anchors `pts[0]`/`pts[n-1]`. */
export function simplify(pts: Pt[]): Pt[] {
  const res: Pt[] = [];
  for (const p of pts) {
    const last = res[res.length - 1];
    if (last && near(last.x, p.x) && near(last.y, p.y)) continue;
    const prev = res[res.length - 2];
    if (prev && last && ((near(prev.x, last.x) && near(last.x, p.x))
        || (near(prev.y, last.y) && near(last.y, p.y)))) res.pop();
    res.push(p);
  }
  return res;
}

function segmentDistance(p: Pt, a: Pt, b: Pt): number {
  return new g.Line(new g.Point(a), new g.Point(b)).closestPoint(new g.Point(p)).distance(new g.Point(p));
}

/**
 * Link view with Simulink-style editing:
 * - drag a segment to move it perpendicular to itself (the route is then
 *   frozen into vertices, see `frozenRouter`);
 * - Ctrl+drag starts a branch: a new wire from the same output port.
 */
export class WireView extends dia.LinkView {
  protected dragStart(evt: dia.Event, x: number, y: number): void {
    if (this.isDefaultInteractionPrevented(evt) || !this.can('linkMove')) return;
    if (evt.ctrlKey || evt.metaKey) {
      this.branchStart(evt, x, y);
      return;
    }
    const pts: Pt[] = [this.sourcePoint, ...this.route, this.targetPoint].map((p) => ({ x: p.x, y: p.y }));
    let seg = -1;
    let best = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const d = segmentDistance({ x, y }, pts[i], pts[i + 1]);
      if (d < best) { best = d; seg = i; }
    }
    if (seg < 0) return;
    const a = pts[seg];
    const b = pts[seg + 1];
    const horizontal = near(a.y, b.y);
    const verts = pts.slice(1, -1);
    // A segment attached to a port can't move as a whole: keep a short stub
    // at the port and add a jog (two coincident points) after it.
    const stub = (from: Pt, to: Pt): Pt => {
      const len = Math.min(STUB, Math.hypot(to.x - from.x, to.y - from.y) / 2);
      return horizontal
        ? { x: from.x + Math.sign(to.x - from.x) * len, y: from.y }
        : { x: from.x, y: from.y + Math.sign(to.y - from.y) * len };
    };
    if (seg === pts.length - 2) {
      const c = stub(b, a);
      verts.push(c, { ...c });
    }
    if (seg === 0) {
      const c = stub(a, b);
      verts.unshift(c, { ...c });
      seg += 2;
    }
    this.paper!.setDragging(evt);
    // `seg` indexes [source, ...verts, target]; it moves verts[seg-1], verts[seg].
    this.eventData(evt, { action: 'move', verts, seg, horizontal, x0: x, y0: y, moved: false });
  }

  protected drag(evt: dia.Event, x: number, y: number): void {
    const d = this.eventData(evt);
    const verts: Pt[] = d.verts.map((p: Pt) => ({ ...p }));
    const [p, q] = [verts[d.seg - 1], verts[d.seg]];
    if (d.horizontal) p.y = q.y = snap(p.y + y - d.y0);
    else p.x = q.x = snap(p.x + x - d.x0);
    if (!d.moved) {
      this.model.router(frozenRouter as any);
      this.eventData(evt, { moved: true });
    }
    this.model.vertices(verts, { ui: true });
  }

  protected dragEnd(evt: dia.Event): void {
    if (!this.eventData(evt).moved) return;
    const pts = simplify([this.sourceAnchor, ...this.model.vertices(), this.targetAnchor]);
    this.model.vertices(pts.slice(1, -1).map((p) => ({ x: p.x, y: p.y })), { ui: true });
  }

  private branchStart(evt: dia.Event, x: number, y: number): void {
    const link = makeLink();
    link.source(this.model.source());
    link.target({ x, y });
    this.paper!.model.addCell(link);
    const view = this.paper!.requireView<dia.LinkView>(link);
    view.eventData(evt, view.startArrowheadMove('target', { whenNotAllowed: 'remove' }) as any);
    this.paper!.setDragging(evt);
    this.eventData(evt, { action: 'branch', branch: view });
  }

  pointermove(evt: dia.Event, x: number, y: number): void {
    const { action, branch } = this.eventData(evt);
    if (action === 'branch') branch.pointermove(evt, x, y);
    else super.pointermove(evt, x, y);
  }

  pointerup(evt: dia.Event, x: number, y: number): void {
    const { action, branch } = this.eventData(evt);
    if (action === 'branch') branch.pointerup(evt, x, y);
    super.pointerup(evt, x, y);
  }
}
