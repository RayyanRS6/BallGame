import { MAX_CHAT_LENGTH } from '../../shared/constants/game.ts';
import { h } from './dom.ts';

/**
 * In-room chat: press Enter to type, Enter to send, Esc to cancel. While the
 * input is focused the game receives a neutral input.
 */
export class ChatBox {
  readonly root: HTMLDivElement;
  private log: HTMLDivElement;
  private input: HTMLInputElement;
  private onSend: (text: string) => void;

  constructor(parent: HTMLElement, onSend: (text: string) => void) {
    this.onSend = onSend;
    this.log = h('div', { class: 'chat-log', 'aria-live': 'polite' });
    this.input = h('input', { class: 'chat-input', maxLength: MAX_CHAT_LENGTH, placeholder: 'Press Enter to chat', spellcheck: false, autocomplete: 'off' });
    this.root = h('div', { class: 'chat' }, this.log, this.input);
    parent.append(this.root);
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const text = this.input.value.trim();
        if (text) this.onSend(text);
        this.input.value = '';
        this.input.blur();
        e.preventDefault();
      } else if (e.key === 'Escape') {
        this.input.value = '';
        this.input.blur();
        e.preventDefault();
      }
    });
    window.addEventListener('keydown', this.onKey);
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || this.focused) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON' || t.tagName === 'SELECT')) return;
    e.preventDefault();
    this.input.focus();
  };

  get focused(): boolean {
    return document.activeElement === this.input;
  }

  add(name: string, text: string, system: boolean, color?: string): void {
    const line = system
      ? h('div', { class: 'chat-line system' }, text)
      : h('div', { class: 'chat-line' }, h('span', { class: 'chat-name', style: color ? { color } : {} }, `${name}: `), text);
    this.log.append(line);
    while (this.log.childElementCount > 60) this.log.firstElementChild?.remove();
    this.log.scrollTop = this.log.scrollHeight;
    line.classList.add('fresh');
    setTimeout(() => line.classList.remove('fresh'), 8000);
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKey);
    this.root.remove();
  }
}
