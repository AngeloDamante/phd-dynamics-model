// JointJS shapes: Simulink-like blocks and orthogonal wires with line hops.
import { dia, shapes } from '@joint/core';
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
