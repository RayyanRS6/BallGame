import { audio } from '../audio/audio.ts';

type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown> & {
  class?: string;
  style?: Partial<CSSStyleDeclaration> | string;
  dataset?: Record<string, string>;
};

/**
 * Tiny DOM builder. Text is always inserted as text nodes (never innerHTML),
 * so player names and chat can never inject markup.
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style') {
        if (typeof v === 'string') el.setAttribute('style', v);
        else Object.assign(el.style, v);
      } else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k in el && typeof v !== 'string') {
        (el as unknown as Record<string, unknown>)[k] = v;
      } else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}

export function button(label: string, onClick: () => void, cls = 'btn'): HTMLButtonElement {
  return h('button', {
    class: cls,
    type: 'button',
    onclick: () => {
      audio.click();
      onClick();
    },
  }, label);
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Sets text only when it changed (avoids needless layout work in the HUD). */
export function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export function field(label: string, control: HTMLElement, hint?: string): HTMLLabelElement {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint ? h('span', { class: 'field-hint' }, hint) : null);
}

export function select<T extends string | number>(options: readonly { value: T; label: string }[], value: T, onChange: (v: T) => void): HTMLSelectElement {
  const el = h('select', { class: 'input' });
  for (const o of options) {
    const opt = h('option', { value: String(o.value) }, o.label);
    if (o.value === value) opt.selected = true;
    el.append(opt);
  }
  el.addEventListener('change', () => {
    const raw = el.value;
    const found = options.find((o) => String(o.value) === raw);
    if (found) onChange(found.value);
  });
  return el;
}

export function checkbox(checked: boolean, onChange: (v: boolean) => void): HTMLInputElement {
  const el = h('input', { type: 'checkbox', class: 'check' });
  el.checked = checked;
  el.addEventListener('change', () => onChange(el.checked));
  return el;
}

export function slider(value: number, min: number, max: number, step: number, onInput: (v: number) => void, format: (v: number) => string = (v) => String(v)): HTMLDivElement {
  const out = h('span', { class: 'slider-value' }, format(value));
  const input = h('input', { type: 'range', class: 'slider', min: String(min), max: String(max), step: String(step) });
  input.value = String(value);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = format(v);
    onInput(v);
  });
  return h('div', { class: 'slider-row' }, input, out);
}

export function textInput(value: string, opts: { placeholder?: string; maxLength?: number; onInput?: (v: string) => void; type?: string } = {}): HTMLInputElement {
  const el = h('input', { class: 'input', type: opts.type ?? 'text', placeholder: opts.placeholder ?? '', maxLength: opts.maxLength ?? 64, spellcheck: false, autocomplete: 'off' });
  el.value = value;
  if (opts.onInput) el.addEventListener('input', () => opts.onInput!(el.value));
  return el;
}

export function downloadBlob(data: string | Uint8Array, filename: string, type: string): void {
  const part: BlobPart = typeof data === 'string' ? data : new Uint8Array(data);
  const url = URL.createObjectURL(new Blob([part], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
