import type { Subscription } from 'rxjs';
import { subscribePanel, closePanel } from './panel';
export function createApp(fixed: boolean) {
  let current: Subscription | null = null;
  return {
    mount() { current = subscribePanel(); document.querySelector('#app')!.textContent = 'Panel mounted'; },
    unmount() { if (fixed && current) closePanel(current); current = null; document.querySelector('#app')!.textContent = ''; },
    state() { return { active: current !== null, children: document.querySelector('#app')!.childElementCount }; },
  };
}
