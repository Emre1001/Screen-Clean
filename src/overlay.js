// Cursor-Overlay des Hosts: transparentes, klick-durchlässiges Fenster über dem
// geteilten Monitor. Bekommt Zustand per Tauri-Event vom Hauptfenster.
import '@fontsource-variable/geist';
import './vendor/i18n.js';
import './locales/en.js';
import './locales/de.js';
import './locales/tr.js';
import { listen } from '@tauri-apps/api/event';
import { cursorLayer } from './views/controls.js';
import './styles/overlay.css';

const layer = document.getElementById('layer');
const banner = document.getElementById('banner');
const cursors = cursorLayer(layer);
const t = (k, p) => window.I18n.t(k, p);
window.I18n.init();

listen('overlay:state', ({ payload }) => {
  cursors.sync(payload.cursors);

  const ctl = payload.controller;
  const key = payload.paused ? 'paused' : ctl ? `ctl:${ctl.name}` : '';
  if (key === banner.dataset.key) return;
  banner.dataset.key = key;
  banner.hidden = !key;
  banner.style.setProperty('--c', ctl?.color || '#f0b443');
  banner.replaceChildren();
  if (payload.paused) banner.append(t('overlay.paused'));
  else if (ctl) {
    const kbd = (t) => Object.assign(document.createElement('kbd'), { textContent: t });
    banner.append(`${t('overlay.control', { name: ctl.name })} `, kbd(t('kbd.ctrl')), kbd('Shift'), kbd('X'));
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
