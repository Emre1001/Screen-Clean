// App-Zustand: persistente Konfiguration + Event-Bus + System-Protokoll.
import { call } from './bridge.js';

export const REPO = 'https://github.com/Emre1001/Screen-Clean';

// Ruhige, gut unterscheidbare Cursor-Farben (keine Neon-Töne)
export const PALETTE = ['#3e63dd', '#e5484d', '#30a46c', '#f76b15', '#8e4ec6', '#12a594', '#d6409f', '#ffb224', '#0090ff', '#978365'];

export const DEFAULT_SETTINGS = {
  theme: 'system', // system | light | dark
  audio: true,
  remoteCursors: true,
  showLog: false,
  diagnostics: false,
  sounds: true,
  quality: 'auto', // auto | gaming | text | saver | manual
  manual: { fps: 60, height: 1080, bitrate: 12 },
  codec: 'auto',
  controlPolicy: 'ask', // ask | auto | deny
  joinPolicy: 'ask', // ask | friends | auto
  autoRequestControl: false,
  reconnect: true,
  lanVisible: true,
  monitor: 'auto',
  closeToTray: true,
  autostart: false,
  compat: false,
  signaling: '',
};

const DEFAULTS = () => ({
  version: 1,
  setupDone: false,
  profile: { name: '', color: PALETTE[0] },
  code: '',
  clientId: crypto.randomUUID(),
  settings: { ...DEFAULT_SETTINGS },
  friends: [], // { code, name, trusted, added }
  history: [], // { code, name, at }
});

export let cfg = DEFAULTS();

// --- Event-Bus -------------------------------------------------------------
const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
export function onEvent(type, fn) {
  const h = (e) => fn(e.detail);
  bus.addEventListener(type, h);
  return () => bus.removeEventListener(type, h);
}

// --- Persistenz ------------------------------------------------------------
export async function loadConfig() {
  const saved = await call('config_load').catch(() => null);
  if (saved && typeof saved === 'object') {
    const d = DEFAULTS();
    cfg = {
      ...d,
      ...saved,
      profile: { ...d.profile, ...saved.profile },
      settings: { ...d.settings, ...saved.settings, manual: { ...d.settings.manual, ...saved.settings?.manual } },
      friends: Array.isArray(saved.friends) ? saved.friends : [],
      history: Array.isArray(saved.history) ? saved.history : [],
    };
  }
  return cfg;
}

let saveTimer;
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => call('config_save', { value: cfg }).catch((e) => log(`Speichern fehlgeschlagen: ${e}`, 'error')), 250);
}

export function setSetting(key, value) {
  cfg.settings[key] = value;
  save();
  emit('settings', { key, value });
}

export function setProfile(p) {
  cfg.profile = { ...cfg.profile, ...p };
  save();
  emit('profile', cfg.profile);
}

// --- Freunde & Verlauf -----------------------------------------------------
export const findFriend = (code) => cfg.friends.find((f) => f.code === code);

export function upsertFriend(code, name, patch = {}) {
  const f = findFriend(code);
  if (f) Object.assign(f, { name: name || f.name }, patch);
  else cfg.friends.unshift({ code, name: name || code, trusted: false, added: Date.now(), ...patch });
  save();
  emit('friends');
}

export function removeFriend(code) {
  cfg.friends = cfg.friends.filter((f) => f.code !== code);
  save();
  emit('friends');
}

export function addHistory(code, name) {
  cfg.history = [{ code, name, at: Date.now() }, ...cfg.history.filter((h) => h.code !== code)].slice(0, 20);
  save();
  emit('history');
}

// --- System-Protokoll ------------------------------------------------------
export const logs = [];
export function log(msg, level = 'info', { fromRust = false } = {}) {
  logs.push({ ts: Date.now(), msg: String(msg), level });
  if (logs.length > 400) logs.shift();
  if (level === 'error') console.error('[sc]', msg);
  if (!fromRust) call('log_write', { level, msg: String(msg) }).catch(() => {});
  emit('log');
}

/** Hell/Dunkel: 'system' folgt dem Betriebssystem (reines CSS), sonst fest. */
export function applyTheme() {
  const t = cfg.settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
