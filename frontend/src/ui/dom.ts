// Tiny DOM helpers.

type Attrs = Record<string, string | number | boolean | ((e: any) => void) | undefined>;
type Child = Node | string | null | undefined | false;

/** Create an element: `el('div', {class: 'x', onclick: fn}, 'text', child)`. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Attrs = {}, ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') (node as any)[k] = v;
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const c of children) if (c) node.append(c);
  return node;
}

/** Floating context menu at the mouse position. */
export function contextMenu(items: { label: string; action: () => void; disabled?: boolean }[],
                            evt: MouseEvent): void {
  document.querySelector('.context-menu')?.remove();
  const menu = el('div', { class: 'context-menu' },
    ...items.map((it) => el('button', {
      disabled: !!it.disabled,
      onclick: () => { menu.remove(); it.action(); },
    }, it.label)));
  menu.style.left = `${evt.clientX}px`;
  menu.style.top = `${evt.clientY}px`;
  document.body.appendChild(menu);
  const dismiss = (e: Event) => {
    if (!menu.contains(e.target as Node)) {
      menu.remove();
      document.removeEventListener('pointerdown', dismiss, true);
    }
  };
  setTimeout(() => document.addEventListener('pointerdown', dismiss, true));
}

/** Modal with a text field; resolves with the value or null. */
export function promptModal(title: string, value = '', okLabel = 'OK'): Promise<string | null> {
  return new Promise((resolve) => {
    const input = el('input', { type: 'text', value });
    const ok = el('button', { class: 'primary' }, okLabel);
    const cancel = el('button', {}, 'Cancel');
    const backdrop = el('div', { class: 'backdrop' },
      el('div', { class: 'modal small' },
        el('header', {}, el('strong', {}, title)),
        el('div', { class: 'modal-body' }, input),
        el('footer', {}, cancel, ok)));
    const close = (v: string | null) => { backdrop.remove(); resolve(v); };
    ok.onclick = () => close(input.value.trim() || null);
    cancel.onclick = () => close(null);
    input.onkeydown = (e: KeyboardEvent) => {
      if (e.key === 'Enter') close(input.value.trim() || null);
      if (e.key === 'Escape') close(null);
    };
    document.body.appendChild(backdrop);
    input.focus();
    input.select();
  });
}

/** Modal listing choices; resolves with the chosen one or null. */
export function chooseModal(title: string, choices: string[], empty: string): Promise<string | null> {
  return new Promise((resolve) => {
    const close = (v: string | null) => { backdrop.remove(); resolve(v); };
    const list = choices.length
      ? el('div', { class: 'choice-list' },
          ...choices.map((c) => el('button', { onclick: () => close(c) }, c)))
      : el('p', { class: 'muted' }, empty);
    const backdrop = el('div', { class: 'backdrop' },
      el('div', { class: 'modal small' },
        el('header', {}, el('strong', {}, title)),
        el('div', { class: 'modal-body' }, list),
        el('footer', {}, el('button', { onclick: () => close(null) }, 'Cancel'))));
    document.body.appendChild(backdrop);
  });
}
