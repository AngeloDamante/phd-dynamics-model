// Diagram editor: a JointJS paper showing one system level of the document.
//
// The DiagramDoc is the source of truth. The graph shows the system at
// `path` (a list of subsystem block ids from the root); user edits on the
// graph are written back to the doc immediately, and structural changes
// (params, ports, navigation, undo) re-render the level from the doc.
import { dia, linkTools } from '@joint/core';
import type { BlockTypeInfo } from '../api';
import {
  type BlockDoc, type DiagramDoc, type SystemDoc, type WireDoc, clone, groupIntoSubsystem,
  newId, refreshSubsystems, resolvePath, subsystemPorts, uniqueName,
} from '../model';
import { CONNECTOR, ERROR_COLOR, ROUTER, SELECT_COLOR, cellNamespace, makeLink, renderBlock, routerFor } from './shapes';

const PAPER_W = 4000;
const PAPER_H = 3000;
const MONITOR_COLOR = '#2a78d6';

export interface EditorEvents {
  selection(blocks: BlockDoc[]): void;
  open(block: BlockDoc, names: string[]): void;
  changed(): void;
  level(names: string[]): void;
  wireHover(wire: WireDoc | null, names: string[], evt?: MouseEvent): void;
  contextMenu(items: MenuItem[], evt: MouseEvent): void;
}

export interface MenuItem {
  label: string;
  action: () => void;
  disabled?: boolean;
}

export class Editor {
  doc: DiagramDoc;
  path: string[] = [];
  readonly graph: dia.Graph;
  readonly paper: dia.Paper;
  private selected = new Set<string>();
  private selectedWire: string | null = null;
  private errorBlocks = new Set<string>();
  private rendering = false;
  private history: string[] = [];
  private future: string[] = [];
  private clipboard: { blocks: BlockDoc[]; wires: WireDoc[] } | null = null;
  private band: { el: HTMLDivElement; x: number; y: number } | null = null;
  private zoom = 1;

  constructor(
    private host: HTMLElement,
    private scroller: HTMLElement,
    private types: Map<string, BlockTypeInfo>,
    private on: EditorEvents,
    doc: DiagramDoc,
  ) {
    this.doc = doc;
    this.graph = new dia.Graph({}, { cellNamespace });
    this.paper = new dia.Paper({
      el: host,
      model: this.graph,
      width: PAPER_W,
      height: PAPER_H,
      gridSize: 10,
      drawGrid: { name: 'dot', args: { color: '#c3c2b7' } },
      background: { color: '#fcfcfb' },
      cellViewNamespace: cellNamespace,
      async: true,
      sorting: dia.Paper.sorting.APPROX,
      defaultLink: () => makeLink(),
      defaultRouter: ROUTER,
      defaultConnector: CONNECTOR,
      defaultConnectionPoint: { name: 'anchor' },
      linkPinning: false,
      snapLinks: { radius: 25 },
      markAvailable: true,
      clickThreshold: 4,
      interactive: (view) => (view.model.isLink() ? { linkMove: false, labelMove: false } : true),
      validateMagnet: (view, magnet) => portOf(view, magnet)?.startsWith('out:') ?? false,
      validateConnection: (sv, sm, tv, tm, _end, lv) => this.canConnect(sv, sm, tv, tm, lv),
    });
    this.bindGraph();
    this.bindPaper();
    this.loadLevel();
    this.commit();
  }

  // ---------------------------------------------------------------- levels

  get system(): SystemDoc {
    return resolvePath(this.doc.root, this.path).sys;
  }

  get names(): string[] {
    return resolvePath(this.doc.root, this.path).names;
  }

  setDoc(doc: DiagramDoc): void {
    this.doc = doc;
    this.path = [];
    this.history = [];
    this.future = [];
    this.errorBlocks.clear();
    this.loadLevel();
    this.commit();
  }

  enter(blockId: string): void {
    this.path = [...this.path, blockId];
    this.selected.clear();
    this.loadLevel();
  }

  goTo(depth: number): void {
    this.path = this.path.slice(0, depth);
    this.selected.clear();
    this.loadLevel();
  }

  /** Re-render the current level from the document. */
  loadLevel(): void {
    refreshSubsystems(this.doc.root);
    const { sys } = resolvePath(this.doc.root, this.path);
    this.rendering = true;
    this.graph.resetCells([]);
    const cells: dia.Cell[] = [];
    for (const b of sys.blocks) {
      const el = new cellNamespace.sim.Block({ id: b.id });
      renderBlock(el, b, sys.blocks);
      cells.push(el);
    }
    for (const w of sys.wires) cells.push(this.wireToLink(w));
    this.graph.addCells(cells);
    this.rendering = false;
    this.selectedWire = null;
    for (const id of [...this.selected]) if (!sys.blocks.some((b) => b.id === id)) this.selected.delete(id);
    this.restyle();
    this.on.level(this.names);
    this.emitSelection();
  }

  private wireToLink(w: WireDoc): dia.Link {
    const link = makeLink();
    link.set({
      id: w.id,
      source: { id: w.src.block, port: `out:${w.src.port}` },
      target: { id: w.dst.block, port: `in:${w.dst.port}` },
      vertices: w.vertices ?? [],
      router: this.routerTo(w.dst.block, w.dst.port),
    });
    return link;
  }

  private routerTo(blockId: string, port: string) {
    const inputs = this.block(blockId)?.ports.inputs ?? [];
    return routerFor(inputs.findIndex((p) => p.name === port), inputs.length);
  }

  // ---------------------------------------------------------- graph -> doc

  private bindGraph(): void {
    this.graph.on('change:position', (el: dia.Element, pos: dia.Point, opt: any) => {
      if (this.rendering) return;
      const b = this.block(el.id as string);
      if (!b) return;
      const dx = pos.x - b.x;
      const dy = pos.y - b.y;
      b.x = pos.x;
      b.y = pos.y;
      // Drag the rest of the selection along.
      if (opt.ui && !opt.group && this.selected.has(b.id) && this.selected.size > 1) {
        for (const id of this.selected) {
          if (id !== b.id) (this.graph.getCell(id) as dia.Element | undefined)?.translate(dx, dy, { group: true });
        }
      }
    });
    this.graph.on('change:source change:target add', (cell: dia.Cell) => {
      if (!this.rendering && cell.isLink()) this.syncLink(cell as dia.Link);
    });
    this.graph.on('change:vertices', (link: dia.Link) => {
      const w = this.system.wires.find((x) => x.id === link.id);
      if (w && !this.rendering) w.vertices = link.vertices().map((v) => ({ x: v.x, y: v.y }));
    });
    this.graph.on('remove', (cell: dia.Cell) => {
      if (this.rendering) return;
      const sys = this.system;
      if (cell.isLink()) {
        sys.wires = sys.wires.filter((w) => w.id !== cell.id);
      } else {
        sys.blocks = sys.blocks.filter((b) => b.id !== cell.id);
        sys.wires = sys.wires.filter((w) => w.src.block !== cell.id && w.dst.block !== cell.id);
        this.selected.delete(cell.id as string);
      }
      this.on.changed();
    });
  }

  private syncLink(link: dia.Link): void {
    const sys = this.system;
    const s = link.source();
    const t = link.target();
    const idx = sys.wires.findIndex((w) => w.id === link.id);
    const complete = s.id && s.port?.startsWith('out:') && t.id && t.port?.startsWith('in:');
    if (!complete) {
      if (idx >= 0) sys.wires.splice(idx, 1);
      return;
    }
    const wire: WireDoc = {
      ...(idx >= 0 ? sys.wires[idx] : {}),
      id: link.id as string,
      src: { block: s.id as string, port: s.port!.slice(4) },
      dst: { block: t.id as string, port: t.port!.slice(3) },
    };
    if (idx >= 0) sys.wires[idx] = wire;
    else sys.wires.push(wire);
    link.router(this.routerTo(wire.dst.block, wire.dst.port));
    this.on.changed();
  }

  private canConnect(sv: dia.CellView, sm: SVGElement, tv: dia.CellView, tm: SVGElement,
                     lv: dia.LinkView): boolean {
    if (!sm || !tm || !tv.model.isElement()) return false;
    const sp = portOf(sv, sm);
    const tp = portOf(tv, tm);
    if (!sp?.startsWith('out:') || !tp?.startsWith('in:')) return false;
    // One driver per input, like a ROS topic with a single publisher.
    return !this.graph.getConnectedLinks(tv.model as dia.Element, { inbound: true })
      .some((l) => l.id !== lv.model.id && l.target().port === tp);
  }

  // ------------------------------------------------------- paper handlers

  private bindPaper(): void {
    const p = this.paper;
    p.on('element:pointerclick', (view: dia.ElementView, evt: dia.Event) => {
      const id = view.model.id as string;
      if (evt.shiftKey || evt.ctrlKey || evt.metaKey) {
        if (this.selected.has(id)) this.selected.delete(id);
        else this.selected.add(id);
      } else {
        this.selected = new Set([id]);
      }
      this.selectWire(null);
      this.restyle();
      this.emitSelection();
    });
    p.on('element:pointerdown', (view: dia.ElementView) => {
      const id = view.model.id as string;
      if (!this.selected.has(id)) {
        this.selected = new Set([id]);
        this.selectWire(null);
        this.restyle();
        this.emitSelection();
      }
    });
    p.on('element:pointerdblclick', (view: dia.ElementView) => {
      const b = this.block(view.model.id as string);
      if (!b) return;
      if (b.type === 'Subsystem') this.enter(b.id);
      else this.on.open(b, this.names);
    });
    p.on('link:pointerclick', (view: dia.LinkView) => {
      this.selected.clear();
      this.selectWire(view.model.id as string);
      this.restyle();
      this.emitSelection();
    });
    p.on('cell:pointerup', () => this.commit());
    p.on('link:connect', () => this.commit());
    p.on('link:mouseenter', (view: dia.LinkView, evt: dia.Event) => {
      const w = this.system.wires.find((x) => x.id === view.model.id);
      this.on.wireHover(w ?? null, this.names, evt.originalEvent as MouseEvent);
    });
    p.on('link:mouseleave', () => this.on.wireHover(null, this.names));

    p.on('blank:pointerdown', (evt: dia.Event, x: number, y: number) => {
      const el = document.createElement('div');
      el.className = 'rubber-band';
      this.host.appendChild(el);
      this.band = { el, x, y };
      if (!evt.shiftKey) {
        this.selected.clear();
        this.selectWire(null);
      }
    });
    p.on('blank:pointermove', (_evt: dia.Event, x: number, y: number) => {
      if (!this.band) return;
      const r = rect(this.band.x, this.band.y, x, y);
      Object.assign(this.band.el.style, {
        left: `${r.x * this.zoom}px`, top: `${r.y * this.zoom}px`,
        width: `${r.width * this.zoom}px`, height: `${r.height * this.zoom}px`,
      });
    });
    p.on('blank:pointerup', (_evt: dia.Event, x: number, y: number) => {
      if (!this.band) return;
      const r = rect(this.band.x, this.band.y, x, y);
      this.band.el.remove();
      this.band = null;
      if (r.width > 3 || r.height > 3) {
        for (const el of this.graph.findElementsInArea(r, { strict: false })) {
          this.selected.add(el.id as string);
        }
      }
      this.restyle();
      this.emitSelection();
    });

    p.on('element:contextmenu', (view: dia.ElementView, evt: dia.Event) => {
      evt.preventDefault();
      const b = this.block(view.model.id as string)!;
      if (!this.selected.has(b.id)) {
        this.selected = new Set([b.id]);
        this.restyle();
        this.emitSelection();
      }
      this.on.contextMenu([
        { label: b.type === 'Subsystem' ? 'Open subsystem' : 'Open',
          action: () => (b.type === 'Subsystem' ? this.enter(b.id) : this.on.open(b, this.names)) },
        { label: 'Group into subsystem  (Ctrl+G)', action: () => this.groupSelection(),
          disabled: this.selected.size < 1 },
        { label: 'Copy  (Ctrl+C)', action: () => this.copy() },
        { label: 'Delete  (Del)', action: () => this.deleteSelection() },
      ], evt.originalEvent as MouseEvent);
    });
    p.on('link:contextmenu', (view: dia.LinkView, evt: dia.Event) => {
      evt.preventDefault();
      const w = this.system.wires.find((x) => x.id === view.model.id);
      if (!w) return;
      this.on.contextMenu([
        { label: w.monitor ? 'Stop monitoring' : 'Monitor in Data Inspector',
          action: () => this.setMonitor(w, !w.monitor) },
        { label: 'Reset route', action: () => { (view.model as dia.Link).vertices([]); this.commit(); } },
        { label: 'Delete', action: () => { view.model.remove(); this.commit(); } },
      ], evt.originalEvent as MouseEvent);
    });
    p.on('blank:contextmenu', (evt: dia.Event) => {
      evt.preventDefault();
      this.on.contextMenu([
        { label: 'Paste  (Ctrl+V)', action: () => this.paste(), disabled: !this.clipboard },
        { label: 'Select all  (Ctrl+A)', action: () => this.selectAll() },
      ], evt.originalEvent as MouseEvent);
    });

    this.scroller.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.setZoom(this.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    }, { passive: false });
  }

  setZoom(z: number): void {
    this.zoom = Math.min(3, Math.max(0.3, z));
    this.paper.scale(this.zoom, this.zoom);
    this.paper.setDimensions(PAPER_W * this.zoom, PAPER_H * this.zoom);
  }

  /** Local paper coordinates of a client (mouse) position. */
  clientToLocal(x: number, y: number): { x: number; y: number } {
    const p = this.paper.clientToLocalPoint(x, y);
    return { x: Math.round(p.x / 10) * 10, y: Math.round(p.y / 10) * 10 };
  }

  // ------------------------------------------------------------ selection

  private block(id: string): BlockDoc | undefined {
    return this.system.blocks.find((b) => b.id === id);
  }

  private selectWire(id: string | null): void {
    if (this.selectedWire) {
      const view = this.paper.findViewByModel(this.selectedWire) as dia.LinkView | undefined;
      view?.removeTools();
    }
    this.selectedWire = id;
    if (id) {
      const view = this.paper.findViewByModel(id) as dia.LinkView | undefined;
      view?.addTools(new dia.ToolsView({
        tools: [new linkTools.Vertices({ snapRadius: 10 }), new linkTools.TargetArrowhead()],
      }));
    }
  }

  selectAll(): void {
    this.selected = new Set(this.system.blocks.map((b) => b.id));
    this.restyle();
    this.emitSelection();
  }

  selectedBlocks(): BlockDoc[] {
    return this.system.blocks.filter((b) => this.selected.has(b.id));
  }

  private emitSelection(): void {
    this.on.selection(this.selectedBlocks());
  }

  /** Mark blocks on an error path (``a/b/c``) that are visible at this level. */
  setErrorPaths(paths: string[]): void {
    this.errorBlocks.clear();
    this.errorPaths = paths;
    this.restyle();
  }

  private errorPaths: string[] = [];

  private restyle(): void {
    const names = this.names;
    const prefix = names.length ? names.join('/') + '/' : '';
    this.errorBlocks.clear();
    for (const p of this.errorPaths) {
      if (!p.startsWith(prefix)) continue;
      const head = p.slice(prefix.length).split('/')[0];
      const b = this.system.blocks.find((x) => x.name === head);
      if (b) this.errorBlocks.add(b.id);
    }
    for (const el of this.graph.getElements()) {
      const id = el.id as string;
      const color = this.errorBlocks.has(id) ? ERROR_COLOR : this.selected.has(id) ? SELECT_COLOR : '#1f1f1f';
      el.attr('body', { stroke: color, strokeWidth: this.selected.has(id) || this.errorBlocks.has(id) ? 2.5 : 1.5 });
    }
    for (const link of this.graph.getLinks()) {
      const w = this.system.wires.find((x) => x.id === link.id);
      const color = link.id === this.selectedWire ? SELECT_COLOR : '#1f1f1f';
      link.attr('line/stroke', color);
      link.attr('line/targetMarker/fill', color);
      link.attr('line/targetMarker/stroke', color);
      link.labels(w?.monitor ? [{
        position: { distance: 18 },
        markup: [{ tagName: 'circle', selector: 'dot' }],
        attrs: { dot: { r: 4, fill: MONITOR_COLOR, stroke: '#fcfcfb', strokeWidth: 2 } },
      }] : []);
    }
  }

  // ------------------------------------------------------------- commands

  /** Add a new block of `type` at local point (x, y). */
  addBlock(type: string, x: number, y: number): BlockDoc {
    const info = this.types.get(type);
    if (!info) throw new Error(`unknown block type ${type}`);
    const sys = this.system;
    const base = { Inport: 'In1', Outport: 'Out1', PythonNode: 'node' }[type] ?? type;
    const params = clone(info.params);
    if (type === 'PythonNode') params.params ??= {};
    const b: BlockDoc = {
      id: newId('b'),
      name: uniqueName(sys, base),
      type,
      params,
      x,
      y,
      ports: { inputs: clone(info.inputs), outputs: clone(info.outputs) },
    };
    if (type === 'Subsystem') {
      const inner: SystemDoc = { blocks: [], wires: [] };
      const i: BlockDoc = { id: newId('b'), name: 'In1', type: 'Inport', x: 60, y: 120,
        params: clone(this.types.get('Inport')!.params), ports: { inputs: [], outputs: [{ name: 'y', dtype: null }] } };
      const o: BlockDoc = { id: newId('b'), name: 'Out1', type: 'Outport', x: 360, y: 120,
        params: clone(this.types.get('Outport')!.params), ports: { inputs: [{ name: 'u', dtype: null }], outputs: [] } };
      inner.blocks.push(i, o);
      inner.wires.push({ id: newId('w'), src: { block: i.id, port: 'y' }, dst: { block: o.id, port: 'u' } });
      b.system = inner;
      b.ports = subsystemPorts(inner);
    }
    sys.blocks.push(b);
    this.selected = new Set([b.id]);
    this.loadLevel();
    this.changedAndCommit();
    return b;
  }

  /** Apply a change to a block of the current level and re-render. */
  updateBlock(id: string, fn: (b: BlockDoc) => void): void {
    const b = this.block(id);
    if (!b) return;
    fn(b);
    this.loadLevel();
    this.changedAndCommit();
  }

  /**
   * Rename a block. For Inport/Outport blocks this renames the enclosing
   * subsystem's port, so wires in the parent level are updated too.
   */
  renameBlock(id: string, name: string): void {
    const b = this.block(id);
    if (!b || b.name === name) return;
    const old = b.name;
    b.name = name;
    if ((b.type === 'Inport' || b.type === 'Outport') && this.path.length) {
      const parent = resolvePath(this.doc.root, this.path.slice(0, -1)).sys;
      const subId = this.path[this.path.length - 1];
      for (const w of parent.wires) {
        if (b.type === 'Inport' && w.dst.block === subId && w.dst.port === old) w.dst.port = name;
        if (b.type === 'Outport' && w.src.block === subId && w.src.port === old) w.src.port = name;
      }
    }
    this.loadLevel();
    this.changedAndCommit();
  }

  setMonitor(w: WireDoc, on: boolean): void {
    w.monitor = on;
    this.restyle();
    this.changedAndCommit();
  }

  deleteSelection(): void {
    if (this.selectedWire) {
      this.graph.getCell(this.selectedWire)?.remove();
      this.selectedWire = null;
    }
    const cells = [...this.selected].map((id) => this.graph.getCell(id)).filter(Boolean);
    this.graph.removeCells(cells as dia.Cell[]);
    this.selected.clear();
    this.emitSelection();
    this.changedAndCommit();
  }

  groupSelection(): void {
    if (this.selected.size === 0) return;
    const sub = groupIntoSubsystem(this.system, new Set(this.selected));
    this.selected = new Set([sub.id]);
    this.loadLevel();
    this.changedAndCommit();
  }

  copy(): void {
    const ids = this.selected;
    if (!ids.size) return;
    this.clipboard = clone({
      blocks: this.selectedBlocks(),
      wires: this.system.wires.filter((w) => ids.has(w.src.block) && ids.has(w.dst.block)),
    });
  }

  paste(): void {
    if (!this.clipboard) return;
    const sys = this.system;
    const data = clone(this.clipboard);
    const remap = new Map<string, string>();
    for (const b of data.blocks) {
      remap.set(b.id, newId('b'));
      b.id = remap.get(b.id)!;
      b.name = uniqueName(sys, b.name);
      b.x += 30;
      b.y += 30;
      sys.blocks.push(b);
    }
    for (const w of data.wires) {
      sys.wires.push({ ...w, id: newId('w'), src: { ...w.src, block: remap.get(w.src.block)! },
        dst: { ...w.dst, block: remap.get(w.dst.block)! } });
    }
    this.clipboard = clone({ blocks: data.blocks, wires: data.wires });
    this.selected = new Set(data.blocks.map((b) => b.id));
    this.loadLevel();
    this.changedAndCommit();
  }

  // -------------------------------------------------------------- history

  private snapshot(): string {
    return JSON.stringify({ root: this.doc.root, path: this.path });
  }

  private changedAndCommit(): void {
    this.on.changed();
    this.commit();
  }

  /** Record an undo point if the document changed since the last one. */
  commit(): void {
    const snap = this.snapshot();
    if (this.history[this.history.length - 1] === snap) return;
    this.history.push(snap);
    if (this.history.length > 200) this.history.shift();
    this.future = [];
    if (this.history.length > 1) this.on.changed();
  }

  undo(): void {
    if (this.history.length < 2) return;
    this.future.push(this.history.pop()!);
    this.restore(this.history[this.history.length - 1]);
  }

  redo(): void {
    const snap = this.future.pop();
    if (!snap) return;
    this.history.push(snap);
    this.restore(snap);
  }

  private restore(snap: string): void {
    const { root, path } = JSON.parse(snap);
    this.doc.root = root;
    this.path = path;
    this.selected.clear();
    this.loadLevel();
    this.on.changed();
  }
}

function portOf(view: dia.CellView, magnet: SVGElement): string | null {
  return view.findAttribute('port', magnet);
}

function rect(x1: number, y1: number, x2: number, y2: number) {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}
