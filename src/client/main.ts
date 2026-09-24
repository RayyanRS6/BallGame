import './styles.css';
import { App } from './app.ts';
import { settings } from './settings.ts';

/** Applies accessibility settings that live in CSS. */
function applyDocumentSettings(): void {
  const a = settings.get().accessibility;
  const root = document.documentElement;
  root.style.setProperty('--ui-scale', String(a.uiScale));
  root.classList.toggle('reduced-motion', a.reducedMotion);
  root.classList.toggle('high-contrast', a.highContrast);
  root.classList.toggle('colorblind', a.colorblind);
}

applyDocumentSettings();
settings.onChange(applyDocumentSettings);

// Keep game keys from scrolling the page; allow normal behaviour inside inputs.
window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement | null;
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
  if (!typing && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code) && t?.tagName !== 'BUTTON') e.preventDefault();
});

const root = document.getElementById('app');
if (!root) throw new Error('#app missing');
try {
  new App(root).start();
} catch (err) {
  root.textContent = `Momentum failed to start: ${(err as Error).message}`;
  console.error(err);
}
