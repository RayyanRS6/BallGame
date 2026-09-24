import { h } from './dom.ts';

let host: HTMLDivElement | null = null;

/** Non-blocking notification in the top-right corner. */
export function toast(message: string, kind: 'info' | 'error' | 'success' = 'info', ms = 3500): void {
  if (!host) {
    host = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(host);
  }
  const el = h('div', { class: `toast toast-${kind}` }, message);
  host.append(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 300);
  }, ms);
}
