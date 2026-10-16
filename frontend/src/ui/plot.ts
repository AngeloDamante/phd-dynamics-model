// Live time-series plot on top of uPlot, fed from the SignalStore.
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { SignalStore } from '../sim';

// Validated categorical palette (light surface #fcfcfb), assigned in fixed
// order by trace index, never cycled. Traces past the 8th fall back to a
// dashed neutral.
export const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100',
  '#e87ba4', '#008300', '#6250d6', '#e34948'];
const OVERFLOW_COLOR = '#898781';
const GRID = '#e1e0d9';
const AXIS = '#898781';

export interface Trace {
  /** Series key in the store. */
  key: string;
  label: string;
  /** Fixed color slot, so a trace keeps its color when others hide. */
  slot: number;
}

type Aligned = [number[], ...(number | null)[][]];

/**
 * Merge per-series (t, v) arrays onto one sorted time axis. Between samples a
 * series holds its last value, like a topic's latest message.
 */
export function align(store: SignalStore, keys: string[]): Aligned {
  const cols = keys.map((k) => store.series.get(k) ?? { t: [], v: [] });
  const idx = cols.map(() => 0);
  const xs: number[] = [];
  const ys: (number | null)[][] = cols.map(() => []);
  for (;;) {
    let tmin = Infinity;
    for (let c = 0; c < cols.length; c++) {
      if (idx[c] < cols[c].t.length && cols[c].t[idx[c]] < tmin) tmin = cols[c].t[idx[c]];
    }
    if (tmin === Infinity) break;
    xs.push(tmin);
    for (let c = 0; c < cols.length; c++) {
      const prev = ys[c].length ? ys[c][ys[c].length - 1] : null;
      let v: number | null = prev;
      // Consume every sample at tmin; the last one wins.
      while (idx[c] < cols[c].t.length && cols[c].t[idx[c]] === tmin) v = cols[c].v[idx[c]++];
      ys[c].push(v);
    }
  }
  return [xs, ...ys];
}

export function toCSV(data: Aligned, labels: string[]): string {
  const rows = [['t', ...labels].join(',')];
  for (let i = 0; i < data[0].length; i++) {
    rows.push([data[0][i], ...data.slice(1).map((col) => col[i] ?? '')].join(','));
  }
  return rows.join('\n');
}

export function download(filename: string, text: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export class PlotView {
  readonly el: HTMLDivElement;
  private plot: uPlot | null = null;
  private traces: Trace[] = [];
  private signature = '';
  private drawnVersion = -1;
  private zoomed = false;
  frozen = false;
  stairs = false;
  private resize = new ResizeObserver(() => this.fit());

  constructor(parent: HTMLElement, private store: SignalStore, private emptyText: string) {
    this.el = document.createElement('div');
    this.el.className = 'plot';
    parent.appendChild(this.el);
    this.resize.observe(this.el);
  }

  setTraces(traces: Trace[]): void {
    const sig = traces.map((t) => `${t.key}:${t.slot}:${t.label}`).join('|') + `|${this.stairs}`;
    if (sig === this.signature) return;
    this.signature = sig;
    this.traces = traces;
    this.rebuild();
  }

  setStairs(on: boolean): void {
    this.stairs = on;
    this.signature = '';
    this.setTraces(this.traces);
  }

  /** Redraw if the store changed (call from an animation-frame loop). */
  refresh(force = false): void {
    if (!this.plot || this.frozen) return;
    if (!force && this.store.version === this.drawnVersion) return;
    this.drawnVersion = this.store.version;
    this.plot.setData(align(this.store, this.traces.map((t) => t.key)), !this.zoomed);
  }

  resetZoom(): void {
    this.zoomed = false;
    this.refresh(true);
  }

  csv(): string {
    return toCSV(align(this.store, this.traces.map((t) => t.key)), this.traces.map((t) => t.label));
  }

  destroy(): void {
    this.resize.disconnect();
    this.plot?.destroy();
    this.el.remove();
  }

  private fit(): void {
    if (!this.plot) return;
    const { width, height } = this.size();
    this.plot.setSize({ width, height });
  }

  private size(): { width: number; height: number } {
    const legend = this.el.querySelector('.u-legend') as HTMLElement | null;
    return {
      width: Math.max(120, this.el.clientWidth),
      height: Math.max(80, this.el.clientHeight - (legend?.offsetHeight ?? 0) - 4),
    };
  }

  private rebuild(): void {
    this.plot?.destroy();
    this.plot = null;
    this.el.innerHTML = '';
    if (this.traces.length === 0) {
      this.el.innerHTML = `<div class="plot-empty">${this.emptyText}</div>`;
      return;
    }
    const paths = this.stairs ? uPlot.paths.stepped!({ align: 1 }) : undefined;
    const axis = { stroke: AXIS, grid: { stroke: GRID, width: 1 }, ticks: { stroke: GRID, width: 1 } };
    const opts: uPlot.Options = {
      ...this.size(),
      scales: {
        x: { time: false },
        // Flat signals get a ±1 band instead of uPlot's default 0..100.
        y: { range: (_u, min, max) => (min === max ? [min - 1, max + 1]
          : uPlot.rangeNum(min, max, 0.1, true)) },
      },
      axes: [{ ...axis, label: 't [s]', labelSize: 18 }, axis],
      cursor: { drag: { x: true, y: true, uni: 20 } },
      legend: { live: true },
      series: [
        { label: 't', value: (_u, v) => (v == null ? '—' : v.toFixed(4)) },
        ...this.traces.map((tr) => ({
          label: tr.label,
          stroke: tr.slot < SERIES_COLORS.length ? SERIES_COLORS[tr.slot] : OVERFLOW_COLOR,
          dash: tr.slot < SERIES_COLORS.length ? undefined : [4, 4],
          width: 2,
          spanGaps: true,
          paths,
          points: { show: false },
          value: (_u: uPlot, v: number | null) => (v == null ? '—' : String(+v.toPrecision(6))),
        })),
      ],
      hooks: {
        setSelect: [() => { this.zoomed = true; }],
      },
    };
    this.plot = new uPlot(opts, align(this.store, this.traces.map((t) => t.key)), this.el);
    this.plot.over.addEventListener('dblclick', () => this.resetZoom());
    this.drawnVersion = this.store.version;
    requestAnimationFrame(() => this.fit());
  }
}
