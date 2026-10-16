// Scope windows, Data Inspector and Log: the monitoring side of the UI.
import type { SignalStore } from '../sim';
import { el } from './dom';
import { PlotView, type Trace, download } from './plot';

/** Views refreshed from the animation-frame loop in main.ts. */
export interface LiveView {
  tick(): void;
}

function plotToolbar(view: PlotView, name: string): HTMLElement {
  const freeze = el('button', { title: 'Freeze the display (the simulation keeps running)' }, '⏸ Freeze');
  freeze.onclick = () => {
    view.frozen = !view.frozen;
    freeze.textContent = view.frozen ? '▶ Live' : '⏸ Freeze';
    if (!view.frozen) view.refresh(true);
  };
  const stairs = el('input', { type: 'checkbox' });
  stairs.onchange = () => view.setStairs(stairs.checked);
  return el('div', { class: 'plot-toolbar' },
    freeze,
    el('button', { title: 'Autoscale (or double-click the plot)', onclick: () => view.resetZoom() }, '⤢ Fit'),
    el('label', { title: 'Draw as zero-order hold (discrete samples)' }, stairs, 'Stairs'),
    el('button', { title: 'Export as CSV', onclick: () => download(`${name}.csv`, view.csv()) }, '⭳ CSV'),
  );
}

/** Floating window plotting the inputs of one Scope block. */
export class ScopeWindow implements LiveView {
  readonly win: HTMLDivElement;
  private view: PlotView;
  private lastScopes: unknown = null;

  constructor(parent: HTMLElement, readonly path: string, private store: SignalStore,
              private onClose: () => void) {
    const close = el('button', { class: 'icon', title: 'Close', onclick: () => this.close() }, '×');
    const header = el('header', {}, el('strong', {}, `Scope · ${path}`), close);
    const body = el('div', { class: 'win-body' });
    this.win = el('div', { class: 'window' }, header, body);
    const offset = parent.children.length * 24;
    Object.assign(this.win.style, { left: `${260 + offset}px`, top: `${90 + offset}px` });
    parent.appendChild(this.win);
    this.view = new PlotView(body, store, 'Run the simulation to see the scope inputs.');
    body.prepend(plotToolbar(this.view, path.replace(/\//g, '_')));
    draggable(this.win, header);
    // Bring to front; moving the node only when needed keeps clicks working.
    this.win.addEventListener('pointerdown', () => {
      if (parent.lastElementChild !== this.win) parent.appendChild(this.win);
    });
    this.tick();
  }

  tick(): void {
    // Rebuild traces when new components appear (vectors) or after a new run.
    const leaves = this.store.scopes[this.path] ?? [];
    const sig = JSON.stringify([leaves, leaves.map((l) => (l ? this.store.seriesOf(l).length : 0))]);
    if (sig !== this.lastScopes) {
      this.lastScopes = sig;
      const traces: Trace[] = [];
      leaves.forEach((leaf, i) => {
        if (!leaf) return;
        for (const k of this.store.seriesOf(leaf)) {
          traces.push({ key: k, label: `in${i + 1} · ${k}`, slot: traces.length });
        }
      });
      this.view.setTraces(traces);
    }
    this.view.refresh();
  }

  close(): void {
    this.view.destroy();
    this.win.remove();
    this.onClose();
  }
}

export interface MonitoredSignal {
  endpoint: string;
  label: string;
}

/** Bottom panel: plot of every monitored wire, with per-signal visibility. */
export class DataInspector implements LiveView {
  readonly root: HTMLElement;
  private list: HTMLElement;
  private view: PlotView;
  private signals: MonitoredSignal[] = [];
  private hidden = new Set<string>();
  private signature = '';

  constructor(parent: HTMLElement, private store: SignalStore) {
    this.list = el('div', { class: 'signal-list' });
    const plotHost = el('div', { class: 'inspector-plot' });
    this.root = el('div', { class: 'data-inspector' }, this.list, plotHost);
    parent.appendChild(this.root);
    this.view = new PlotView(plotHost, store,
      'Right-click a wire → “Monitor in Data Inspector”, then run the simulation.');
    plotHost.prepend(plotToolbar(this.view, 'signals'));
    this.renderList();
  }

  setSignals(signals: MonitoredSignal[]): void {
    this.signals = signals;
    this.renderList();
    this.signature = '';
    this.tick();
  }

  private renderList(): void {
    this.list.innerHTML = '';
    if (!this.signals.length) {
      this.list.append(el('p', { class: 'muted small' }, 'No monitored signals.'));
      return;
    }
    for (const s of this.signals) {
      const box = el('input', { type: 'checkbox', checked: !this.hidden.has(s.endpoint) });
      box.onchange = () => {
        if (box.checked) this.hidden.delete(s.endpoint);
        else this.hidden.add(s.endpoint);
        this.signature = '';
        this.tick();
      };
      this.list.append(el('label', { title: s.endpoint }, box, s.label));
    }
  }

  tick(): void {
    // Slots are assigned over all signals so hiding one never recolors others.
    const traces: Trace[] = [];
    let slot = 0;
    for (const s of this.signals) {
      const leaf = this.store.leafOf(s.endpoint);
      const keys = leaf ? this.store.seriesOf(leaf) : [];
      for (const k of keys.length ? keys : [null]) {
        if (k && !this.hidden.has(s.endpoint)) {
          traces.push({ key: k, label: s.label + (leaf ? k.slice(leaf.length) : ''), slot });
        }
        slot++;
      }
    }
    const sig = JSON.stringify(traces);
    if (sig !== this.signature) {
      this.signature = sig;
      this.view.setTraces(traces);
    }
    this.view.refresh();
  }
}

export type LogLevel = 'info' | 'error';

/** Bottom panel tab with run messages and callback tracebacks. */
export class Log {
  readonly root: HTMLElement;

  constructor(parent: HTMLElement) {
    this.root = el('div', { class: 'log' });
    parent.appendChild(this.root);
  }

  add(level: LogLevel, message: string, opts: { traceback?: string; goTo?: () => void } = {}): void {
    const time = new Date().toLocaleTimeString();
    const entry = el('div', { class: `log-entry ${level}` },
      el('span', { class: 'log-time' }, time),
      el('span', { class: 'log-icon' }, level === 'error' ? '✖' : 'ℹ'),
      el('span', {}, message),
      opts.goTo ? el('button', { class: 'small', onclick: opts.goTo }, 'Show block') : null);
    this.root.append(entry);
    if (opts.traceback) this.root.append(el('pre', { class: 'traceback' }, opts.traceback));
    this.root.scrollTop = this.root.scrollHeight;
  }

  clear(): void {
    this.root.innerHTML = '';
  }
}

function draggable(win: HTMLElement, handle: HTMLElement): void {
  handle.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const sx = e.clientX - win.offsetLeft;
    const sy = e.clientY - win.offsetTop;
    const move = (m: PointerEvent) => {
      win.style.left = `${Math.max(0, m.clientX - sx)}px`;
      win.style.top = `${Math.max(0, m.clientY - sy)}px`;
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });
}
