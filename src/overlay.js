// Cursor-Overlay des Hosts: transparentes, klick-durchlässiges Fenster über dem
// geteilten Monitor. Bekommt Zustand per Tauri-Event vom Hauptfenster.
import '@fontsource-variable/geist';
import { listen } from '@tauri-apps/api/event';
import { cursorEl } from './views/controls.js';
import './styles/overlay.css';

const layer = document.getElementById('layer');
const banner = document.getElementById('banner');
const els = new Map();

listen('overlay:state', ({ payload }) => {
  const seen = new Set();
  for (const c of payload.cursors) {
    seen.add(c.id);
    const key = `${c.name}${c.color}${c.ctl}`;
    let el = els.get(c.id);
    if (!el || el.dataset.key !== key) {
      el?.remove();
      el = cursorEl(c.name, c.color, c.ctl);
      el.dataset.key = key;
      layer.append(el);
      els.set(c.id, el);
    }
    el.style.left = `${c.x * 100}%`;
    el.style.top = `${c.y * 100}%`;
  }
  for (const [id, el] of els) if (!seen.has(id)) { el.remove(); els.delete(id); }

  const ctl = payload.controller;
  const key = payload.paused ? 'paused' : ctl ? `ctl:${ctl.name}` : '';
  if (key === banner.dataset.key) return;
  banner.dataset.key = key;
  banner.hidden = !key;
  banner.style.setProperty('--c', ctl?.color || '#f0b443');
  banner.replaceChildren();
  if (payload.paused) banner.append('Übertragung pausiert');
  else if (ctl) {
    const kbd = (t) => Object.assign(document.createElement('kbd'), { textContent: t });
    banner.append(`${ctl.name} steuert deinen Computer · Stopp mit `, kbd('Strg'), kbd('Shift'), kbd('X'));
  }
});

listen('overlay:react', ({ payload }) => {
  const f = document.createElement('div');
  f.className = 'floater';
  f.style.left = `${70 + Math.random() * 25}%`;
  f.style.setProperty('--c', payload.color);
  f.innerHTML = '<span class="emoji"></span><span class="who"></span>';
  f.firstChild.textContent = payload.emoji;
  f.lastChild.textContent = payload.name;
  layer.append(f);
  setTimeout(() => f.remove(), 2600);
});
