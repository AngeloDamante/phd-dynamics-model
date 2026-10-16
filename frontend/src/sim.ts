// WebSocket simulation client and live signal store.
// Protocol: see backend/simnode/runner.py and backend/simnode/api/app.py.
import type { DiagramDoc } from './model';

export interface TopicInfo {
  value: string;
  count: number;
  rate: number | null;
}

export type SimState = 'idle' | 'starting' | 'running' | 'paused' | 'done' | 'error';

export type SimEvent =
  | { type: 'started'; dt: number; stop_time: number; aliases: Record<string, string>;
      scopes: Record<string, (string | null)[]> }
  | { type: 'status'; state: 'running' | 'paused'; t: number }
  | { type: 'data'; t: number; series: Record<string, [number[], (number | null)[]]> }
  | { type: 'topics'; t: number; topics: Record<string, TopicInfo> }
  | { type: 'error'; phase: 'build' | 'run'; message: string; path: string | null;
      paths?: string[]; t?: number; traceback?: string }
  | { type: 'done'; t: number }
  | { type: 'stopped'; killed: boolean };

export interface Series {
  t: number[];
  v: (number | null)[];
}

/** Samples, topic stats and name resolution of the current/last run. */
export class SignalStore {
  series = new Map<string, Series>();
  topics: Record<string, TopicInfo> = {};
  aliases: Record<string, string> = {};
  scopes: Record<string, (string | null)[]> = {};
  /** Incremented on every change, so views can skip redundant redraws. */
  version = 0;

  clear(): void {
    this.series.clear();
    this.topics = {};
    this.aliases = {};
    this.scopes = {};
    this.version++;
  }

  /** Leaf output key driving an endpoint key (any level). */
  leafOf(endpoint: string): string | undefined {
    return this.aliases[endpoint];
  }

  /** Series keys belonging to leaf output `leaf` (scalars, `[i]`, `.field`). */
  seriesOf(leaf: string): string[] {
    const keys: string[] = [];
    for (const k of this.series.keys()) {
      if (k === leaf || k.startsWith(leaf + '[') || k.startsWith(leaf + '.')) keys.push(k);
    }
    return keys.sort();
  }

  append(batch: Record<string, [number[], (number | null)[]]>): void {
    for (const [k, [ts, vs]] of Object.entries(batch)) {
      let s = this.series.get(k);
      if (!s) this.series.set(k, (s = { t: [], v: [] }));
      for (let i = 0; i < ts.length; i++) {
        s.t.push(ts[i]);
        s.v.push(vs[i]);
      }
    }
    this.version++;
  }
}

type Listener = (ev: SimEvent) => void;

/** One WebSocket to `/api/sim`, reconnected on each run. */
export class SimClient {
  readonly store = new SignalStore();
  state: SimState = 'idle';
  time = 0;
  private ws: WebSocket | null = null;
  private listeners: Listener[] = [];

  on(fn: Listener): void {
    this.listeners.push(fn);
  }

  private emit(ev: SimEvent): void {
    switch (ev.type) {
      case 'started':
        this.store.aliases = ev.aliases;
        this.store.scopes = ev.scopes;
        this.store.version++;
        break;
      case 'status':
        this.state = ev.state;
        this.time = ev.t;
        break;
      case 'data':
        this.store.append(ev.series);
        this.time = ev.t;
        break;
      case 'topics':
        this.store.topics = ev.topics;
        this.time = ev.t;
        break;
      case 'error':
        this.state = 'error';
        break;
      case 'done':
        this.state = 'done';
        this.time = ev.t;
        break;
      case 'stopped':
        if (this.state !== 'error') this.state = 'done';
        break;
    }
    for (const fn of this.listeners) fn(ev);
  }

  private async socket(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return this.ws;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/sim`);
    ws.onmessage = (m) => this.emit(JSON.parse(m.data) as SimEvent);
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      if (this.state === 'running' || this.state === 'paused' || this.state === 'starting') {
        this.emit({ type: 'error', phase: 'run', message: 'connection to server lost', path: null });
      }
    };
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('cannot connect to the simulation server'));
    });
    this.ws = ws;
    return ws;
  }

  async start(doc: DiagramDoc, monitors: string[], startPaused = false): Promise<void> {
    this.store.clear();
    this.state = 'starting';
    this.time = 0;
    const ws = await this.socket();
    const diagram = { ...doc, sim: { ...doc.sim, start_paused: startPaused } };
    ws.send(JSON.stringify({ cmd: 'start', diagram, monitors }));
  }

  send(msg: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  get active(): boolean {
    return this.state === 'running' || this.state === 'paused' || this.state === 'starting';
  }
}
