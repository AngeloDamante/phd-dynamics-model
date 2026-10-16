// Modal Monaco editor for PythonNode callbacks.
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/languages/definitions/python/register';
// editor.api is the bare core: opt into the editor features we use.
import 'monaco-editor/features/suggest/register';
// The suggest widget itself is not part of features/suggest.
import 'monaco-editor/editor/contrib/suggest/browser/suggestController';
import 'monaco-editor/features/snippet/register';
import 'monaco-editor/features/hover/register';
import 'monaco-editor/features/find/register';
import 'monaco-editor/features/comment/register';
import 'monaco-editor/features/bracketMatching/register';
import 'monaco-editor/features/folding/register';
import 'monaco-editor/features/wordHighlighter/register';
import 'monaco-editor/features/clipboard/register';
import 'monaco-editor/features/contextmenu/register';
import 'monaco-editor/features/gotoError/register';
import 'monaco-editor/features/multicursor/register';
import 'monaco-editor/features/linesOperations/register';
import 'monaco-editor/features/indentation/register';
import 'monaco-editor/features/wordOperations/register';
import 'monaco-editor/features/cursorUndo/register';
import 'monaco-editor/features/parameterHints/register';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import { api } from '../api';
import type { BlockDoc } from '../model';
import { el } from './dom';

(self as any).MonacoEnvironment = { getWorker: () => new EditorWorker() };

/** Names offered after `inp.`, `out.`, `p.` for the node being edited. */
let completionContext: { inp: string[]; out: string[]; p: string[] } = { inp: [], out: [], p: [] };

monaco.languages.registerCompletionItemProvider('python', {
  triggerCharacters: ['.'],
  provideCompletionItems(model, position) {
    const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
    const m = /\b(inp|out|p)\.(\w*)$/.exec(line);
    if (!m) return { suggestions: [] };
    const word = model.getWordUntilPosition(position);
    const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
    const kind = m[1] as 'inp' | 'out' | 'p';
    const names = [...completionContext[kind]];
    if (kind === 'inp') names.push('fresh', 'received');
    const detail = { inp: 'input port', out: 'output port', p: 'parameter' }[kind];
    return {
      suggestions: names.map((n) => ({
        label: n,
        kind: n === 'fresh' || n === 'received'
          ? monaco.languages.CompletionItemKind.Method
          : monaco.languages.CompletionItemKind.Field,
        insertText: n === 'fresh' || n === 'received' ? `${n}("$1")` : n,
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        detail,
        range,
      })),
    };
  },
});

/** Open the editor for `block`; resolves with the new code, or null if cancelled. */
export function editCode(block: BlockDoc, title: string): Promise<string | null> {
  const p = block.params;
  completionContext = {
    inp: block.ports.inputs.map((x) => x.name),
    out: block.ports.outputs.map((x) => x.name),
    p: Object.keys(p.params ?? {}),
  };
  return new Promise((resolve) => {
    const hint = el('div', { class: 'code-hint' },
      el('span', {}, `inputs: ${completionContext.inp.join(', ') || '—'}`),
      el('span', {}, `outputs: ${completionContext.out.join(', ') || '—'}`),
      el('span', {}, `params: ${completionContext.p.join(', ') || '—'}`),
      el('span', {}, p.sample_time != null ? `periodic, Ts = ${p.sample_time} s` : 'on message'),
    );
    const status = el('span', { class: 'code-status' });
    const host = el('div', { class: 'code-host' });
    const save = el('button', { class: 'primary' }, 'Save  (Ctrl+S)');
    const cancel = el('button', {}, 'Cancel');
    const dialog = el('div', { class: 'modal code-modal' },
      el('header', {}, el('strong', {}, title), status),
      hint, host,
      el('footer', {}, cancel, save));
    const backdrop = el('div', { class: 'backdrop' }, dialog);
    document.body.appendChild(backdrop);

    const editor = monaco.editor.create(host, {
      value: p.code ?? '',
      language: 'python',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      tabSize: 4,
      insertSpaces: true,
      scrollBeyondLastLine: false,
    });
    editor.focus();

    let timer = 0;
    const check = async () => {
      const model = editor.getModel();
      if (!model) return;
      try {
        const { problems } = await api.checkCode(model.getValue());
        monaco.editor.setModelMarkers(model, 'simnode', problems.map((pr) => ({
          severity: monaco.MarkerSeverity.Error,
          message: pr.message,
          startLineNumber: pr.line, startColumn: pr.column,
          endLineNumber: pr.line, endColumn: model.getLineMaxColumn(pr.line),
        })));
        status.textContent = problems.length ? `⚠ ${problems[0].message} (line ${problems[0].line})` : '✓ syntax ok';
        status.className = `code-status ${problems.length ? 'bad' : 'ok'}`;
      } catch {
        status.textContent = '';
      }
    };
    editor.onDidChangeModelContent(() => {
      clearTimeout(timer);
      timer = window.setTimeout(check, 400);
    });
    check();

    const close = (result: string | null) => {
      clearTimeout(timer);
      editor.getModel()?.dispose();
      editor.dispose();
      backdrop.remove();
      resolve(result);
    };
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => close(editor.getValue()));
    // Escape only closes an unmodified editor, so edits are never lost by accident.
    const original = p.code ?? '';
    editor.addCommand(monaco.KeyCode.Escape, () => {
      if (editor.getValue() === original) close(null);
      else status.textContent = 'Unsaved changes: Save (Ctrl+S) or Cancel';
    }, '!suggestWidgetVisible && !findWidgetVisible');
    save.onclick = () => close(editor.getValue());
    cancel.onclick = () => close(null);
  });
}
