// Dünne Schicht über Tauri. Drei Modi:
//  - Tauri-IPC (Windows/macOS, Linux mit WebRTC-fähigem WebKitGTK)
//  - Browser-Modus: UI läuft in Chrome/Firefox, Befehle per HTTP an Rust (web.rs)
//  - Mocks im normalen Browser (npm run dev), damit UI und P2P testbar sind
import { invoke } from '@tauri-apps/api/core';
import { listen, emitTo as tauriEmitTo } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

export const isTauri = !!window.__TAURI_INTERNALS__;
const params = new URLSearchParams(location.search);
const session = (k) => {
  try {
    return sessionStorage.getItem(k);
  } catch {
    return null;
  }
};
const boot = params.get('boot');
const webApi = params.get('api') || session('sc-api') || location.origin;
export const isWeb = !isTauri && !!(boot || session('sc-token'));

// Einmal-Token aus der URL gegen Sitzungs-Token tauschen (siehe web.rs)
const webReady = isWeb
  ? (async () => {
      let t = session('sc-token');
      if (!t) {
        const r = await fetch(`${webApi}/session`, { method: 'POST', headers: { 'x-boot': boot } });
        if (!r.ok) throw new Error('Sitzung abgelaufen – über das Tray-Symbol neu öffnen.');
        t = await r.json();
        try {
          sessionStorage.setItem('sc-token', t);
          sessionStorage.setItem('sc-api', webApi);
        } catch {
          /* ohne Storage gilt der Token nur bis zum Neuladen */
        }
      }
      history.replaceState(null, '', location.pathname);
      return t;
    })()
  : null;

async function webCall(cmd, args) {
  const r = await fetch(`${webApi}/api/${cmd}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-token': await webReady },
    body: JSON.stringify(args),
  });
  const v = await r.json().catch(() => null);
  if (!r.ok) throw v ?? r.statusText;
  return v;
}

let events;
function webOn(event, cb) {
  const h = (e) => cb(JSON.parse(e.data));
  return webReady.then((t) => {
    events ||= new EventSource(`${webApi}/events?token=${t}`);
    events.addEventListener(event, h);
    return () => events.removeEventListener(event, h);
  });
}

const LS_KEY = 'screen-clean:config';
const mocks = {
  config_load: () => JSON.parse(localStorage.getItem(LS_KEY) || 'null'),
  config_save: ({ value }) => localStorage.setItem(LS_KEY, JSON.stringify(value)),
  sys_info: () => ({ os: 'web', arch: '', hostname: '', session: '', version: 'dev' }),
  list_monitors: () => [{
    name: 'Bildschirm', primary: true, scale: devicePixelRatio,
    rect: { x: 0, y: 0, w: Math.round(screen.width * devicePixelRatio), h: Math.round(screen.height * devicePixelRatio) },
  }],
  input_check: () => 'browser',
  discovery_status: () => { throw 'Nur in der Desktop-App'; },
  overlay_show: () => false,
  autostart_get: () => false,
  autostart_set: () => false,
  open_url: ({ url }) => window.open(url, '_blank', 'noopener'),
  restart: () => location.reload(),
};

export async function call(cmd, args = {}) {
  if (isTauri) return invoke(cmd, args);
  if (isWeb) return webCall(cmd, args);
  const fn = mocks[cmd];
  return fn ? fn(args) : undefined;
}

export function on(event, cb) {
  if (isTauri) return listen(event, (e) => cb(e.payload));
  return isWeb ? webOn(event, cb) : Promise.resolve(() => {});
}

export function emitTo(label, event, payload) {
  if (isTauri) return tauriEmitTo(label, event, payload).catch(() => {});
  return isWeb ? webCall('emit_to', { target: label, event, payload }).catch(() => {}) : Promise.resolve();
}

export const win = {
  async fullscreen(on) {
    if (isTauri) return getCurrentWindow().setFullscreen(on);
    if (on) return document.documentElement.requestFullscreen?.();
    if (document.fullscreenElement) return document.exitFullscreen();
  },
  async attention() {
    if (!isTauri) return;
    const w = getCurrentWindow();
    await w.show();
    await w.unminimize();
    await w.requestUserAttention(2).catch(() => {});
  },
  async focus() {
    if (!isTauri) return;
    const w = getCurrentWindow();
    await w.show();
    await w.unminimize();
    await w.setFocus();
  },
};
