import { button, h } from './dom.ts';

export interface ModalAction {
  label: string;
  onClick: () => void;
  primary?: boolean;
  danger?: boolean;
}

export interface ModalHandle {
  el: HTMLDivElement;
  body: HTMLDivElement;
  close(): void;
}

/** Centered dialog rendered into `parent`. */
export function openModal(parent: HTMLElement, title: string, content: Node | null, actions: ModalAction[], opts: { wide?: boolean; onClose?: () => void } = {}): ModalHandle {
  const body = h('div', { class: 'modal-body' });
  if (content) body.append(content);
  const footer = h('div', { class: 'modal-actions' });
  const handle: ModalHandle = {
    el: null as unknown as HTMLDivElement,
    body,
    close() {
      el.remove();
      opts.onClose?.();
    },
  };
  for (const a of actions) {
    footer.append(button(a.label, a.onClick, `btn${a.primary ? ' primary' : ''}${a.danger ? ' danger' : ''}`));
  }
  const el = h('div', { class: 'modal-backdrop' }, h('div', { class: `modal${opts.wide ? ' wide' : ''}`, role: 'dialog', 'aria-label': title }, h('h2', { class: 'modal-title' }, title), body, actions.length ? footer : null));
  handle.el = el;
  parent.append(el);
  const first = el.querySelector<HTMLElement>('button, input, select');
  first?.focus();
  return handle;
}
