// App-Zustand: persistente Konfiguration + Event-Bus + System-Protokoll.
import { call } from './bridge.js';

export const REPO = 'https://github.com/Emre1001/Screen-Clean';

// Ruhige, gut unterscheidbare Cursor-Farben (keine Neon-Töne)
export const PALETTE = ['#3e63dd', '#e5484d', '#30a46c', '#f76b15', '#8e4ec6', '#12a594', '#d6409f', '#ffb224', '#0090ff', '#978365'];

export const DEFAULT_SETTINGS = {
  theme: 'system', // system | light | dark
  audio: true,
  remoteCursors: true,
  shareCursors: true, // Host: Zuschauer-Cursor überhaupt zeigen
  cursorNames: 'full', // full | initial | off – was Zuschauer an fremden Cursorn sehen
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
let scope = null;
export function onEvent(type, fn) {
  const h = (e) => fn(e.detail);
  bus.addEventListener(type, h);
  const off = () => bus.removeEventListener(type, h);
  scope?.push(off);
  return off;
}

/** Baut etwas und sammelt alle dabei angelegten Abos – zum späteren Abräumen. */
export function collect(build) {
  const prev = scope;
  scope = [];
  try {
    const result = build();
    return [result, scope];
  } finally {
    scope = prev;
  }
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

// --- Erscheinungsbild ------------------------------------------------------
const darkMq = matchMedia('(prefers-color-scheme: dark)');

/**
 * Hell/Dunkel anwenden. `origin` = Mittelpunkt des geklickten Bedienelements:
 * dann wächst das neue Theme als Kreis von dort aus über den Bildschirm.
 */
export function applyTheme(origin) {
  const pref = cfg.settings.theme;
  const root = document.documentElement;
  const next = pref === 'dark' || (pref === 'system' && darkMq.matches) ? 'dark' : 'light';
  try {
    localStorage.setItem('theme', pref); // für das Vor-Zeichnen-Skript in index.html
  } catch {
    /* Speicher gesperrt – Theme gilt trotzdem */
  }
  if (root.dataset.theme === next) return;
  const set = () => (root.dataset.theme = next);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !document.startViewTransition) return set();
  root.classList.add('theme-switching');
  if (origin) root.classList.add('theme-reveal');
  const vt = document.startViewTransition(set);
  if (origin) {
    const { x, y } = origin;
    const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    vt.ready.then(() => root.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
      { duration: 700, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', pseudoElement: '::view-transition-new(root)' },
    ));
  }
  const done = () => root.classList.remove('theme-switching', 'theme-reveal');
  vt.finished.finally(done);
  setTimeout(done, 1500); // falls der Übergang hängt (z. B. Fenster verdeckt): Übergänge nie dauerhaft einfrieren
}
darkMq.addEventListener('change', () => cfg.settings.theme === 'system' && applyTheme());

/** Mittelpunkt eines Elements – Ursprung für den Kreis-Übergang. */
export function originOf(el) {
  if (!el?.getBoundingClientRect) return undefined;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
