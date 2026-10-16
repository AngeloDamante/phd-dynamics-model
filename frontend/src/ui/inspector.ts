// Right panel: properties of the selected block.
import { api, type BlockTypeInfo } from '../api';
import type { Editor } from '../canvas/editor';
import { type BlockDoc, isIdentifier } from '../model';
import { el } from './dom';

type PortRow = { name: string; dtype: string | null };

const STRUCTURAL = new Set(['Subsystem', 'Inport', 'Outport']);

export class Inspector {
  private block: BlockDoc | null = null;

  constructor(
    private root: HTMLElement,
    private editor: Editor,
    private types: Map<string, BlockTypeInfo>,
    private actions: { editCode(b: BlockDoc): void; openScope(b: BlockDoc): void },
  ) {
    this.show([]);
  }

  show(blocks: BlockDoc[]): void {
    this.block = blocks.length === 1 ? blocks[0] : null;
    this.root.innerHTML = '';
    if (blocks.length > 1) {
      this.root.append(
        el('h2', {}, `${blocks.length} blocks selected`),
        el('button', { onclick: () => this.editor.groupSelection() }, 'Group into subsystem (Ctrl+G)'),
      );
      return;
    }
    if (!this.block) {
      this.root.append(el('h2', {}, 'Properties'),
        el('p', { class: 'muted' }, 'Select a block to edit it. Drag blocks from the library, ' +
          'wire an output (▷ on the right) to an input (▷ on the left).'),
        el('p', { class: 'muted' }, 'Right-click a wire to monitor it. Double-click a ' +
          'subsystem to open it, a Python node to edit its code, a scope to see its plot.'));
      return;
    }
    const b = this.block;
    const info = this.types.get(b.type);
    this.root.append(
      el('h2', {}, b.type),
      el('p', { class: 'muted' }, info?.description ?? ''),
      this.nameField(b),
    );
    if (b.type === 'PythonNode') this.pythonForm(b);
    else if (b.type === 'Subsystem') {
      this.root.append(el('button', { onclick: () => this.editor.enter(b.id) }, 'Open subsystem'));
    } else this.genericForm(b);
    if (b.type === 'Scope') {
      this.root.append(el('button', { onclick: () => this.actions.openScope(b) }, 'Open scope'));
    }
  }

  // ------------------------------------------------------------ fields

  private nameField(b: BlockDoc): HTMLElement {
    const error = el('div', { class: 'field-error' });
    const input = el('input', { type: 'text', value: b.name });
    input.onchange = () => {
      const name = input.value.trim();
      const taken = this.editor.system.blocks.some((x) => x.id !== b.id && x.name === name);
      const boundary = b.type === 'Inport' || b.type === 'Outport';
      const msg = !name ? 'name is required'
        : name.includes('/') ? 'name cannot contain "/"'
        : taken ? 'another block has this name'
        : boundary && !isIdentifier(name) ? 'port names must be Python identifiers'
        : '';
      error.textContent = msg;
      if (!msg) this.editor.renameBlock(b.id, name);
    };
    return field('Name', input, error);
  }

  private genericForm(b: BlockDoc): void {
    const defaults = this.types.get(b.type)?.params ?? {};
    for (const [key, def] of Object.entries(defaults)) {
      const error = el('div', { class: 'field-error' });
      const value = b.params[key];
      let input: HTMLInputElement | HTMLTextAreaElement;
      let read: () => any;
      if (typeof def === 'boolean') {
        input = el('input', { type: 'checkbox', checked: !!value });
        read = () => (input as HTMLInputElement).checked;
      } else if (typeof def === 'number') {
        input = el('input', { type: 'number', step: 'any', value: String(value) });
        read = () => {
          const n = Number(input.value);
          if (input.value.trim() === '' || !Number.isFinite(n)) throw new Error('enter a number');
          return n;
        };
      } else if (typeof def === 'string') {
        input = el('input', { type: 'text', value: String(value ?? '') });
        read = () => input.value;
      } else {
        // null defaults (optional values) and structured values: JSON-ish.
        input = el('input', { type: 'text', value: value == null ? '' : JSON.stringify(value),
          placeholder: 'empty = none; numbers, "strings", [lists]' });
        read = () => parseLoose(input.value);
      }
      input.onchange = () => this.applyParam(b, key, read, error);
      this.root.append(field(key, input, error));
    }
  }

  private async applyParam(b: BlockDoc, key: string, read: () => any, error: HTMLElement) {
    let value: any;
    try {
      value = read();
    } catch (e) {
      error.textContent = (e as Error).message;
      return;
    }
    const params = { ...b.params, [key]: value };
    try {
      const ports = STRUCTURAL.has(b.type) ? b.ports : await api.ports(b.type, params);
      error.textContent = '';
      this.editor.updateBlock(b.id, (x) => {
        x.params = params;
        x.ports = ports;
        if (b.type === 'Inport') x.ports = { inputs: [], outputs: [{ name: 'y', dtype: params.dtype ?? null }] };
        if (b.type === 'Outport') x.ports = { inputs: [{ name: 'u', dtype: params.dtype ?? null }], outputs: [] };
      });
    } catch (e) {
      error.textContent = (e as Error).message;
    }
  }

  // ------------------------------------------------------- python node

  private pythonForm(b: BlockDoc): void {
    const p = b.params;
    const inputs = portRows(p.inputs);
    const outputs = portRows(p.outputs);

    this.root.append(el('button', { class: 'primary wide', onclick: () => this.actions.editCode(b) },
      'Edit callback code…'));

    // Trigger
    const periodic = p.sample_time != null;
    const mode = el('select', {},
      el('option', { value: 'periodic', selected: periodic }, 'Periodic (timer)'),
      el('option', { value: 'message', selected: !periodic }, 'On message (subscriber)'));
    const ts = el('input', { type: 'number', step: 'any', min: '0', value: String(p.sample_time ?? 0.01) });
    const tsError = el('div', { class: 'field-error' });
    const trig = new Set<string>(p.trigger_ports ?? []);
    const trigBoxes = el('div', { class: 'checks' },
      ...inputs.map((port) => {
        const box = el('input', { type: 'checkbox', checked: trig.has(port.name) });
        box.onchange = () => {
          if (box.checked) trig.add(port.name);
          else trig.delete(port.name);
          this.applyPython(b, { trigger_ports: trig.size ? [...trig] : null });
        };
        return el('label', {}, box, port.name);
      }));
    const trigHint = el('p', { class: 'muted small' }, 'Fire on messages from the checked inputs (none checked = any input).');
    const renderTrigger = () => {
      const isPeriodic = mode.value === 'periodic';
      ts.disabled = !isPeriodic;
      trigBoxes.style.display = trigHint.style.display = isPeriodic ? 'none' : '';
    };
    mode.onchange = () => {
      renderTrigger();
      this.applyPython(b, { sample_time: mode.value === 'periodic' ? Number(ts.value) || 0.01 : null });
    };
    ts.onchange = () => {
      const v = Number(ts.value);
      tsError.textContent = v > 0 ? '' : 'sample time must be > 0';
      if (v > 0) this.applyPython(b, { sample_time: v });
    };
    renderTrigger();
    this.root.append(el('h3', {}, 'Trigger'), field('Mode', mode), field('Sample time [s]', ts, tsError),
      trigBoxes, trigHint);

    const ft = el('input', { type: 'checkbox', checked: p.direct_feedthrough !== false });
    ft.onchange = () => this.applyPython(b, { direct_feedthrough: ft.checked });
    this.root.append(el('label', { class: 'check-row' }, ft, 'Direct feedthrough'),
      el('p', { class: 'muted small' }, 'Uncheck for nodes whose outputs depend only on their state ' +
        '(e.g. a plant model): they then read the previous tick\'s inputs, which breaks feedback loops.'));

    this.root.append(el('h3', {}, 'Inputs (subscribers)'),
      this.portEditor(inputs, (rows) => this.applyPython(b, { inputs: rows })));
    this.root.append(el('h3', {}, 'Outputs (publishers)'),
      this.portEditor(outputs, (rows) => this.applyPython(b, { outputs: rows })));
    this.root.append(el('h3', {}, 'Parameters'),
      this.paramEditor(p.params ?? {}, (params) => this.applyPython(b, { params })));
  }

  private applyPython(b: BlockDoc, patch: Record<string, any>): void {
    const params = { ...b.params, ...patch };
    const inputs = portRows(params.inputs);
    if (params.trigger_ports) {
      params.trigger_ports = params.trigger_ports.filter((n: string) => inputs.some((i) => i.name === n));
      if (!params.trigger_ports.length) params.trigger_ports = null;
    }
    this.editor.updateBlock(b.id, (x) => {
      x.params = params;
      x.ports = { inputs, outputs: portRows(params.outputs) };
    });
  }

  private portEditor(rows: PortRow[], apply: (rows: PortRow[]) => void): HTMLElement {
    const error = el('div', { class: 'field-error' });
    const list = el('div', { class: 'rows' });
    const commit = () => {
      const names = rows.map((r) => r.name);
      const bad = rows.find((r) => !isIdentifier(r.name) || ['fresh', 'received'].includes(r.name));
      const dupe = names.find((n, i) => names.indexOf(n) !== i);
      error.textContent = bad ? `"${bad.name}" is not a valid port name` : dupe ? `duplicate port "${dupe}"` : '';
      if (!error.textContent) apply(rows.map((r) => ({ ...r })));
    };
    rows.forEach((r, i) => {
      const name = el('input', { type: 'text', value: r.name, placeholder: 'name' });
      const dtype = el('input', { type: 'text', value: r.dtype ?? '', placeholder: 'type (optional)' });
      name.onchange = () => { r.name = name.value.trim(); commit(); };
      dtype.onchange = () => { r.dtype = dtype.value.trim() || null; commit(); };
      list.append(el('div', { class: 'row' }, name, dtype,
        el('button', { class: 'icon', title: 'Remove', onclick: () => { rows.splice(i, 1); commit(); } }, '×')));
    });
    const add = el('button', { class: 'small', onclick: () => {
      const taken = new Set(rows.map((r) => r.name));
      let n = rows.length + 1;
      while (taken.has(`x${n}`)) n++;
      rows.push({ name: `x${n}`, dtype: null });
      commit();
    } }, '+ Add port');
    return el('div', {}, list, add, error);
  }

  private paramEditor(params: Record<string, any>, apply: (p: Record<string, any>) => void): HTMLElement {
    const entries = Object.entries(params).map(([k, v]) => ({ k, v: JSON.stringify(v) }));
    const error = el('div', { class: 'field-error' });
    const commit = () => {
      const out: Record<string, any> = {};
      for (const { k, v } of entries) {
        if (!isIdentifier(k)) { error.textContent = `"${k}" is not a valid parameter name`; return; }
        try { out[k] = parseLoose(v); } catch (e) { error.textContent = `${k}: ${(e as Error).message}`; return; }
      }
      error.textContent = '';
      apply(out);
    };
    const list = el('div', { class: 'rows' });
    entries.forEach((e, i) => {
      const k = el('input', { type: 'text', value: e.k, placeholder: 'name' });
      const v = el('input', { type: 'text', value: e.v, placeholder: 'value (number, [list], "text")' });
      k.onchange = () => { e.k = k.value.trim(); commit(); };
      v.onchange = () => { e.v = v.value; commit(); };
      list.append(el('div', { class: 'row' }, k, v,
        el('button', { class: 'icon', title: 'Remove', onclick: () => { entries.splice(i, 1); commit(); } }, '×')));
    });
    const add = el('button', { class: 'small', onclick: () => {
      let n = entries.length + 1;
      while (entries.some((e) => e.k === `k${n}`)) n++;
      entries.push({ k: `k${n}`, v: '0' });
      commit();
    } }, '+ Add parameter');
    return el('div', {}, list, add, error);
  }
}

function field(label: string, input: HTMLElement, error?: HTMLElement): HTMLElement {
  return el('label', { class: 'field' }, el('span', {}, label), input, error);
}

function portRows(decl: any[] | null | undefined): PortRow[] {
  return (decl ?? []).map((p) => (typeof p === 'string' ? { name: p, dtype: null }
    : { name: p.name, dtype: p.dtype ?? null }));
}

/** Parse user input: empty → null, JSON when valid, otherwise a plain string. */
export function parseLoose(text: string): any {
  const s = text.trim();
  if (s === '') return null;
  try {
    return JSON.parse(s);
  } catch {
    if (/^[\[{"]/.test(s)) throw new Error('invalid JSON');
    return s;
  }
}
