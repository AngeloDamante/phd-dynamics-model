import './style.css';
import { api, type BlockTypeInfo } from './api';
import { Editor } from './canvas/editor';
import {
  type BlockDoc, type DiagramDoc, type WireDoc, emptyDiagram, endpointKey, monitoredEndpoints,
  refreshSubsystems, resolvePath,
} from './model';
import { SimClient } from './sim';
import { chooseModal, contextMenu, el, promptModal } from './ui/dom';
import { Inspector } from './ui/inspector';
import { DataInspector, Log, ScopeWindow } from './ui/monitor';

const $ = (id: string) => document.getElementById(id)!;

async function main(): Promise<void> {
  let blockTypes: BlockTypeInfo[];
  try {
    blockTypes = await api.blocks();
  } catch {
    document.body.innerHTML = '<p class="fatal">Cannot reach the backend. Start it with ' +
      '<code>python -m simnode.api</code> (from <code>backend/</code>).</p>';
    return;
  }
  const types = new Map(blockTypes.map((t) => [t.type, t]));
  const sim = new SimClient();
  const scopes = new Map<string, ScopeWindow>();
  let dirty = false;
  let savedName: string | null = null;

  // ------------------------------------------------------------ bottom
  const bottom = $('bottom');
  const tabs = el('div', { class: 'tabs' });
  const panes = el('div', { class: 'panes' });
  bottom.append(tabs, panes);
  const inspectorPane = el('div', { class: 'pane' });
  const logPane = el('div', { class: 'pane' });
  panes.append(inspectorPane, logPane);
  const dataInspector = new DataInspector(inspectorPane, sim.store);
  const log = new Log(logPane);
  const tabButtons = [
    el('button', { class: 'tab' }, 'Data Inspector'),
    el('button', { class: 'tab' }, 'Log'),
  ];
  const showTab = (i: number) => {
    tabButtons.forEach((b, j) => b.classList.toggle('active', i === j));
    [inspectorPane, logPane].forEach((p, j) => p.classList.toggle('active', i === j));
  };
  tabButtons.forEach((b, i) => (b.onclick = () => showTab(i)));
  const collapse = el('button', { class: 'tab collapse', title: 'Show/hide panel' }, '▾');
  collapse.onclick = () => {
    document.body.classList.toggle('bottom-collapsed');
    collapse.textContent = document.body.classList.contains('bottom-collapsed') ? '▴' : '▾';
  };
  tabs.append(...tabButtons, collapse);
  showTab(0);

  // ------------------------------------------------------------ editor
  const tooltip = el('div', { class: 'wire-tooltip' });
  document.body.appendChild(tooltip);
  let hovered: { wire: WireDoc; names: string[] } | null = null;
  let inspector: Inspector | null = null;
  let ready = false;

  const editor: Editor = new Editor($('paper'), $('canvas-scroll'), types, {
    selection: (blocks) => inspector?.show(blocks),
    open: (b, names) => openBlock(b, names),
    changed: () => {
      dirty = true;
      updateTitle();
      dataInspector.setSignals(monitoredSignals());
    },
    // Fires once from the constructor, before `editor` is assigned.
    level: (names) => { if (ready) renderBreadcrumb(names); },
    wireHover: (wire, names, evt) => {
      hovered = wire ? { wire, names } : null;
      if (evt) Object.assign(tooltip.style, { left: `${evt.clientX + 14}px`, top: `${evt.clientY + 14}px` });
      renderTooltip();
    },
    contextMenu: (items, evt) => contextMenu(items, evt),
  }, emptyDiagram());
  ready = true;
  inspector = new Inspector($('inspector'), editor, types, {
    editCode: (b) => openBlock(b, editor.names),
    openScope: (b) => openScope(endpointPath(editor.names, b.name)),
  });

  /** ROS-style topic name of an endpoint: ``a/b.y`` -> ``/a/b/y``. */
  function topicName(endpoint: string): string {
    const i = endpoint.lastIndexOf('.');
    return `/${endpoint.slice(0, i)}/${endpoint.slice(i + 1)}`;
  }

  function endpointPath(names: string[], block: string): string {
    return [...names, block].join('/');
  }

  function monitoredSignals() {
    return monitoredEndpoints(editor.doc.root).map((endpoint) => ({ endpoint, label: endpoint }));
  }

  function renderTooltip(): void {
    if (!hovered) {
      tooltip.style.display = 'none';
      return;
    }
    const sys = resolvePath(editor.doc.root, editor.path).sys;
    const src = sys.blocks.find((b) => b.id === hovered!.wire.src.block);
    if (!src) return;
    const endpoint = endpointKey(hovered.names, src.name, hovered.wire.src.port);
    const leaf = sim.store.leafOf(endpoint);
    const topic = leaf ? sim.store.topics[leaf] : undefined;
    const dtype = src.ports.outputs.find((p) => p.name === hovered!.wire.src.port)?.dtype;
    tooltip.innerHTML = '';
    tooltip.append(
      el('div', { class: 'tt-title' }, topicName(endpoint)),
      dtype ? el('div', {}, `type: ${dtype}`) : '',
      topic
        ? el('div', {}, el('div', {}, `value: ${topic.value}`),
            el('div', {}, `rate: ${topic.rate == null ? '—' : `${topic.rate.toFixed(1)} Hz (sim)`}`),
            el('div', {}, `messages: ${topic.count}`))
        : el('div', { class: 'muted' }, sim.active || sim.state === 'done' ? 'no messages' : 'run to see live values'),
      hovered.wire.monitor ? el('div', { class: 'muted' }, '◉ monitored') : '',
    );
    tooltip.style.display = 'block';
  }

  function renderBreadcrumb(names: string[]): void {
    const nav = $('breadcrumb');
    nav.innerHTML = '';
    nav.append(el('button', { onclick: () => editor.goTo(0) }, editor.doc.name));
    names.forEach((n, i) => {
      nav.append(el('span', {}, '›'), el('button', { onclick: () => editor.goTo(i + 1) }, n));
    });
  }

  async function openBlock(b: BlockDoc, names: string[]): Promise<void> {
    if (b.type === 'PythonNode') {
      // Monaco is large: load it on first use.
      const { editCode } = await import('./ui/codeEditor');
      const code = await editCode(b, `${endpointPath(names, b.name)} — callback`);
      if (code != null && code !== b.params.code) {
        editor.updateBlock(b.id, (x) => { x.params = { ...x.params, code }; });
      }
    } else if (b.type === 'Scope') {
      openScope(endpointPath(names, b.name));
    }
  }

  function openScope(path: string): void {
    const existing = scopes.get(path);
    if (existing) {
      $('windows').appendChild(existing.win);
      return;
    }
    scopes.set(path, new ScopeWindow($('windows'), path, sim.store, () => scopes.delete(path)));
  }

  // ------------------------------------------------------------ palette
  const palette = $('palette');
  const categories = new Map<string, BlockTypeInfo[]>();
  const ORDER = ['Sources', 'Math', 'Discrete', 'User-Defined', 'Ports & Subsystems', 'Sinks'];
  const rank = (c: string) => (ORDER.indexOf(c) + 1 || ORDER.length + 1);
  for (const t of [...blockTypes].sort((a, b) => rank(a.category) - rank(b.category))) {
    if (!categories.has(t.category)) categories.set(t.category, []);
    categories.get(t.category)!.push(t);
  }
  palette.append(el('h2', {}, 'Library'));
  for (const [cat, list] of categories) {
    palette.append(el('h3', {}, cat));
    for (const t of list) {
      const item = el('div', { class: 'palette-item', draggable: 'true', title: t.description }, t.type);
      item.ondragstart = (e: DragEvent) => e.dataTransfer!.setData('application/x-simnode-block', t.type);
      item.ondblclick = () => {
        const s = $('canvas-scroll');
        const r = s.getBoundingClientRect();
        const p = editor.clientToLocal(r.left + r.width / 2, r.top + r.height / 2);
        editor.addBlock(t.type, p.x, p.y);
      };
      palette.append(item);
    }
  }
  const scroll = $('canvas-scroll');
  scroll.addEventListener('dragover', (e) => e.preventDefault());
  scroll.addEventListener('drop', (e) => {
    const type = e.dataTransfer?.getData('application/x-simnode-block');
    if (!type) return;
    e.preventDefault();
    const p = editor.clientToLocal(e.clientX, e.clientY);
    editor.addBlock(type, p.x - 30, p.y - 20);
  });

  // ------------------------------------------------------------ toolbar
  const stopTime = el('input', { type: 'number', step: 'any', min: '0', class: 'num', title: 'Stop time [s]' });
  const baseStep = el('input', { type: 'text', class: 'num', placeholder: 'auto',
    title: 'Base step [s]; auto = GCD of the sample times' });
  const realtime = el('input', { type: 'checkbox' });
  const speed = el('select', {},
    ...[0.1, 0.25, 0.5, 1, 2, 5, 10].map((v) => el('option', { value: String(v) }, `×${v}`)));
  const runBtn = el('button', { class: 'primary', title: 'Run (F5)' }, '▶ Run');
  const pauseBtn = el('button', { title: 'Pause / resume (F6)' }, '⏸ Pause');
  const stepBtn = el('button', { title: 'Step one tick (F10)' }, '⏭ Step');
  const stopBtn = el('button', { title: 'Stop (Shift+F5)' }, '■ Stop');
  const timeLabel = el('span', { class: 'sim-time' }, 't = 0');
  const stateLabel = el('span', { class: 'sim-state' }, 'idle');
  const title = el('span', { class: 'doc-title' });
  $('toolbar').append(
    el('span', { class: 'logo' }, 'simnode'),
    el('button', { onclick: () => newDiagram() }, 'New'),
    el('button', { onclick: () => openDiagram() }, 'Open…'),
    el('button', { onclick: () => save(false), title: 'Save (Ctrl+S)' }, 'Save'),
    el('button', { onclick: () => save(true) }, 'Save as…'),
    title,
    el('span', { class: 'sep' }),
    el('label', {}, 'Stop', stopTime, 's'),
    el('label', {}, 'dt', baseStep),
    el('label', { title: 'Pace the simulation with the wall clock' }, realtime, 'Real time', speed),
    el('span', { class: 'sep' }),
    runBtn, pauseBtn, stepBtn, stopBtn,
    timeLabel, stateLabel,
  );

  function syncSettingsToForm(): void {
    const s = editor.doc.sim;
    stopTime.value = String(s.stop_time);
    baseStep.value = s.base_step == null ? '' : String(s.base_step);
    realtime.checked = s.realtime;
    speed.value = String(s.speed);
    speed.disabled = !s.realtime;
  }
  stopTime.onchange = () => {
    const v = Number(stopTime.value);
    if (v > 0) editor.doc.sim.stop_time = v;
    syncSettingsToForm();
    markDirty();
  };
  baseStep.onchange = () => {
    const v = Number(baseStep.value);
    editor.doc.sim.base_step = baseStep.value.trim() && v > 0 ? v : null;
    syncSettingsToForm();
    markDirty();
  };
  const speedChanged = () => {
    editor.doc.sim.realtime = realtime.checked;
    editor.doc.sim.speed = Number(speed.value);
    speed.disabled = !realtime.checked;
    sim.send({ cmd: 'speed', realtime: realtime.checked, speed: Number(speed.value) });
    markDirty();
  };
  realtime.onchange = speedChanged;
  speed.onchange = speedChanged;

  function markDirty(): void {
    dirty = true;
    updateTitle();
  }

  function updateTitle(): void {
    title.textContent = `${editor.doc.name}${dirty ? ' •' : ''}`;
    document.title = `${editor.doc.name}${dirty ? ' •' : ''} — simnode`;
  }

  function updateControls(): void {
    const s = sim.state;
    runBtn.disabled = sim.active;
    pauseBtn.disabled = !(s === 'running' || s === 'paused');
    pauseBtn.textContent = s === 'paused' ? '▶ Resume' : '⏸ Pause';
    stepBtn.disabled = s === 'starting' || s === 'running';
    stopBtn.disabled = !sim.active;
    stateLabel.textContent = s;
    stateLabel.className = `sim-state ${s}`;
    timeLabel.textContent = `t = ${sim.time.toFixed(3)} s`;
  }

  // ------------------------------------------------------------ running
  async function run(startPaused = false): Promise<void> {
    refreshSubsystems(editor.doc.root);
    editor.setErrorPaths([]);
    try {
      await sim.start(editor.doc, monitoredEndpoints(editor.doc.root), startPaused);
    } catch (e) {
      log.add('error', (e as Error).message);
      sim.state = 'error';
    }
    updateControls();
  }

  /** Navigate to the level that contains block path `path` (names). */
  function showBlock(path: string): void {
    const parts = path.split('/');
    const ids: string[] = [];
    let sys = editor.doc.root;
    for (const name of parts.slice(0, -1)) {
      const b = sys.blocks.find((x) => x.name === name);
      if (!b?.system) break;
      ids.push(b.id);
      sys = b.system;
    }
    editor.goTo(0);
    for (const id of ids) editor.enter(id);
  }

  sim.on((ev) => {
    switch (ev.type) {
      case 'started':
        log.add('info', `simulation started (base step ${ev.dt} s, stop ${ev.stop_time} s)`);
        break;
      case 'error': {
        const where = ev.path ? `${ev.path}: ` : '';
        const when = ev.t != null ? ` at t = ${ev.t}` : '';
        log.add('error', `${ev.phase === 'build' ? 'build error' : 'runtime error'}${when} — ${where}${ev.message}`,
          { traceback: ev.traceback, goTo: ev.path ? () => showBlock(ev.path!) : undefined });
        editor.setErrorPaths(ev.paths ?? (ev.path ? [ev.path] : []));
        showTab(1);
        break;
      }
      case 'done':
        log.add('info', `simulation finished at t = ${ev.t.toFixed(3)} s`);
        break;
      case 'stopped':
        log.add('info', ev.killed ? 'simulation killed (a callback did not return)' : 'simulation stopped');
        break;
      case 'topics':
        renderTooltip();
        break;
    }
    updateControls();
  });

  runBtn.onclick = () => run();
  pauseBtn.onclick = () => sim.send({ cmd: sim.state === 'paused' ? 'resume' : 'pause' });
  stepBtn.onclick = () => (sim.active ? sim.send({ cmd: 'step' }) : run(true).then(() => sim.send({ cmd: 'step' })));
  stopBtn.onclick = () => sim.send({ cmd: 'stop' });

  // ------------------------------------------------------------ files
  function loadDoc(doc: DiagramDoc, name: string | null): void {
    for (const s of [...scopes.values()]) s.close();
    editor.setDoc(doc);
    savedName = name;
    dirty = false;
    syncSettingsToForm();
    updateTitle();
    dataInspector.setSignals(monitoredSignals());
  }

  async function confirmDiscard(): Promise<boolean> {
    if (!dirty) return true;
    const answer = await chooseModal('Discard unsaved changes?', ['Discard changes'], '');
    return answer !== null;
  }

  async function newDiagram(): Promise<void> {
    if (await confirmDiscard()) loadDoc(emptyDiagram(), null);
  }

  async function openDiagram(): Promise<void> {
    const name = await chooseModal('Open diagram', await api.listDiagrams(), 'No saved diagrams yet.');
    if (!name || !(await confirmDiscard())) return;
    try {
      loadDoc(await api.loadDiagram(name), name);
      localStorage.setItem('simnode:last', name);
    } catch (e) {
      log.add('error', `cannot open ${name}: ${(e as Error).message}`);
      showTab(1);
    }
  }

  async function save(as: boolean): Promise<void> {
    let name = savedName;
    if (as || !name) {
      name = await promptModal('Save diagram as', savedName ?? editor.doc.name, 'Save');
      if (!name) return;
    }
    refreshSubsystems(editor.doc.root);
    try {
      editor.doc.name = name;
      await api.saveDiagram(name, editor.doc);
      savedName = name;
      dirty = false;
      updateTitle();
      renderBreadcrumb(editor.names);
      localStorage.setItem('simnode:last', name);
      log.add('info', `saved ${name}`);
    } catch (e) {
      log.add('error', `save failed: ${(e as Error).message}`);
      showTab(1);
    }
  }

  window.addEventListener('beforeunload', (e) => {
    if (dirty) e.preventDefault();
  });

  // ------------------------------------------------------------ keys
  document.addEventListener('keydown', (e) => {
    const typing = (e.target as HTMLElement).closest('input, textarea, select, .monaco-editor, .modal');
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); if (!typing) save(false); return; }
    if (e.key === 'F5') { e.preventDefault(); if (e.shiftKey) stopBtn.click(); else if (!runBtn.disabled) runBtn.click(); return; }
    if (e.key === 'F6') { e.preventDefault(); if (!pauseBtn.disabled) pauseBtn.click(); return; }
    if (e.key === 'F10') { e.preventDefault(); if (!stepBtn.disabled) stepBtn.click(); return; }
    if (typing) return;
    const k = e.key.toLowerCase();
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); editor.deleteSelection(); }
    else if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); editor.undo(); }
    else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); editor.redo(); }
    else if (mod && k === 'g') { e.preventDefault(); editor.groupSelection(); }
    else if (mod && k === 'c') { editor.copy(); }
    else if (mod && k === 'v') { e.preventDefault(); editor.paste(); }
    else if (mod && k === 'a') { e.preventDefault(); editor.selectAll(); }
    else if (e.key === 'Escape' && editor.path.length) { editor.goTo(editor.path.length - 1); }
  });

  // ------------------------------------------------------------ live loop
  const loop = () => {
    for (const s of scopes.values()) s.tick();
    dataInspector.tick();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  setInterval(() => { if (sim.active) timeLabel.textContent = `t = ${sim.time.toFixed(3)} s`; }, 100);

  // Reopen the last diagram, if any.
  const last = localStorage.getItem('simnode:last');
  let initial: { doc: DiagramDoc; name: string | null } = { doc: emptyDiagram(), name: null };
  if (last) {
    try {
      initial = { doc: await api.loadDiagram(last), name: last };
    } catch { /* deleted or invalid: start empty */ }
  }
  loadDoc(initial.doc, initial.name);
  updateControls();
}

main();
