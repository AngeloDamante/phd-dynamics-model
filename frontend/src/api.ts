// REST client for backend/simnode/api/app.py.
import type { DiagramDoc, Ports } from './model';

export interface BlockTypeInfo extends Ports {
  type: string;
  category: string;
  description: string;
  params: Record<string, any>;
}

export interface CodeProblem {
  line: number;
  column: number;
  message: string;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch { /* not JSON */ }
    throw new Error(String(detail));
  }
  return res.json() as Promise<T>;
}

export const api = {
  blocks: () => request<BlockTypeInfo[]>('GET', '/api/blocks'),
  ports: (type: string, params: Record<string, any>) =>
    request<Ports>('POST', '/api/blocks/ports', { type, params }),
  checkCode: (code: string) =>
    request<{ problems: CodeProblem[] }>('POST', '/api/code/check', { code }),
  listDiagrams: () => request<string[]>('GET', '/api/diagrams'),
  loadDiagram: (name: string) => request<DiagramDoc>('GET', `/api/diagrams/${encodeURIComponent(name)}`),
  saveDiagram: (name: string, doc: DiagramDoc) =>
    request<{ ok: boolean }>('PUT', `/api/diagrams/${encodeURIComponent(name)}`, doc),
};
