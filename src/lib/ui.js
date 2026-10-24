// DOM-Helfer: Elemente, Icons, Toasts, Sheets, Sounds, Bewegung.
import {
  createElement, Activity, ArrowRight, ArrowLeft, Check, ChevronLeft, ChevronRight, CircleCheck, Copy, Cpu, Crown,
  Eye, Gamepad2, Globe, Hand, Info, Keyboard, Laptop, LogIn, LogOut, Maximize, Minimize, MessageCircle, Monitor,
  MonitorUp, MousePointer2, Pause, Play, Plus, RefreshCw, ScreenShare, ScreenShareOff, ScrollText, Send, Settings,
  Shield, ShieldCheck, SlidersHorizontal, Sparkles, Star, Trash2, TriangleAlert, Users, Volume2, VolumeX, Wifi, X,
  Zap, History, FileText, Sun, Moon, SunMoon, Radio, ChevronDown,
} from 'lucide';
import '../vendor/i18n.js';
import { cfg } from './store.js';

/** Übersetzung – Schlüssel stehen in src/locales/. */
export const t = (key, params) => window.I18n.t(key, params);

const ICONS = {
  Activity, ArrowRight, ArrowLeft, Check, ChevronLeft, ChevronRight, CircleCheck, Copy, Cpu, Crown, Eye, Gamepad2,
  Globe, Hand, Info, Keyboard, Laptop, LogIn, LogOut, Maximize, Minimize, MessageCircle, Monitor, MonitorUp,
  MousePointer2, Pause, Play, Plus, RefreshCw, ScreenShare, ScreenShareOff, ScrollText, Send, Settings, Shield,
  ShieldCheck, SlidersHorizontal, Sparkles, Star, Trash2, TriangleAlert, Users, Volume2, VolumeX, Wifi, X, Zap,
  History, FileText, Sun, Moon, SunMoon, Radio, ChevronDown,
};

export function icon(name, size = 18, cls = '') {
  const el = createElement(ICONS[name] || ICONS.Info, { width: size, height: size, 'stroke-width': 1.75, 'aria-hidden': 'true' });
  el.classList.add('i');
  if (cls) el.classList.add(...cls.split(' '));
  return el;
}

/**
 * h('button.btn.primary', { onclick }, 'Text', child)
 * Attribute: on* = Listener, style-Objekt (inkl. --vars), dataset, Rest per setAttribute.
 */
export function h(tag, attrs, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className += ` ${v}`;
    else if (k === 'style' && typeof v === 'object') for (const [p, val] of Object.entries(v)) el.style.setProperty(p.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), val);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function mount(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

/** Kinder nacheinander einblenden (CSS .stagger nutzt --i). */
export function stagger(el) {
  el.classList.add('stagger');
  [...el.children].forEach((c, i) => c.style.setProperty('--i', i));
  return el;
}

/** Ansichtswechsel mit View-Transitions-API, sonst sofort. */
export function transition(fn) {
  if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) return fn();
  document.startViewTransition(fn);
}

/** Lesbare Textfarbe (dunkel/hell) für eine Hintergrundfarbe. */
export function onColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#141416' : '#ffffff';
}

export const initials = (name) => (name || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

export function avatar(name, color, size = 32) {
  return h('span.avatar', { style: { '--c': color, width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.38)}px` } }, initials(name));
}

export function relTime(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  const I = window.I18n;
  if (s < 60) return I.relative(0, 'second');
  if (s < 3600) return I.relative(-Math.round(s / 60), 'minute');
  if (s < 86400) return I.relative(-Math.round(s / 3600), 'hour');
  return I.date(new Date(ts), { day: 'numeric', month: 'short' });
}

/** Button mit Ladezustand: btn.loading(true) */
export function button(cls, { icon: ic, label, onclick, tip, ...attrs } = {}) {
  const el = h(`button${cls}`, { type: 'button', onclick, 'data-tip': tip, ...attrs },
    ic && icon(ic, 17, label ? '' : ''), label && h('span.label', label), h('span.btn-spin', h('span.spinner')));
  el.loading = (on) => el.classList.toggle('loading', on);
  return el;
}

// Lichtpunkt auf Buttons folgt dem Zeiger (eine Delegation für alle)
document.addEventListener('pointermove', (e) => {
  const b = e.target.closest?.('.btn');
  if (!b) return;
  const r = b.getBoundingClientRect();
  b.style.setProperty('--mx', `${e.clientX - r.left}px`);
  b.style.setProperty('--my', `${e.clientY - r.top}px`);
}, { passive: true });

// --- Toasts ---------------------------------------------------------------
export function toast(msg, { type = 'info', icon: ic, ms = 3200, action } = {}) {
  const root = document.getElementById('toasts');
  const close = () => {
    if (!el.isConnected) return;
    el.classList.add('out');
    setTimeout(() => el.remove(), 230);
  };
  const el = h(`div.toast.${type}${action ? '.has-action' : ''}`, { role: 'status' },
    icon(ic || { ok: 'CircleCheck', warn: 'TriangleAlert', error: 'TriangleAlert' }[type] || 'Info', 17),
    h('span', msg),
    action && h('button.btn.sm', { onclick: () => { action.run(); close(); } }, action.label));
  root.prepend(el);
  while (root.children.length > 3) root.lastChild.remove();
  if (ms) setTimeout(close, ms);
  return close;
}

// --- Sheets ---------------------------------------------------------------
export function sheet(content, { wide = false, onClose, dismissable = true } = {}) {
  const root = document.getElementById('modals');
  const prevFocus = document.activeElement;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    back.classList.add('out');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => back.remove(), 210);
    prevFocus?.focus?.();
    onClose?.();
  };
  const onKey = (e) => e.key === 'Escape' && dismissable && close();
  const box = h(`div.sheet${wide ? '.wide' : ''}`, { role: 'dialog', 'aria-modal': 'true' });
  const back = h('div.backdrop', { onmousedown: (e) => e.target === back && dismissable && close() }, box);
  mount(box, typeof content === 'function' ? content(close) : content);
  root.append(back);
  document.addEventListener('keydown', onKey);
  requestAnimationFrame(() => box.querySelector('[autofocus], input, .btn.primary')?.focus());
  return close;
}

export function confirmDialog({ title, text, ok = t('common.ok'), cancel = t('common.cancel'), danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    sheet((close) => [
      h('h2', title),
      text && h('p.muted', text),
      h('div.sheet-actions',
        h('button.btn.ghost', { onclick: close }, cancel),
        h(`button.btn.${danger ? 'danger' : 'primary'}`, { onclick: () => { result = true; close(); } }, ok)),
    ], { onClose: () => resolve(result) });
  });
}

/** Kopieren mit Icon-Morph (Kopieren → Haken) am auslösenden Button. */
export async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      btn.classList.add('swapped');
      clearTimeout(btn._t);
      btn._t = setTimeout(() => btn.classList.remove('swapped'), 1400);
    } else toast(t('common.copied'), { type: 'ok', ms: 1600 });
  } catch {
    toast(t('common.copyFailed'), { type: 'error' });
  }
}

export function copyButton(getText, cls = '.icon-btn', tip = t('common.copy'), label = '') {
  const b = h(`button${cls}`, { type: 'button', 'data-tip': tip || null, onclick: () => copy(getText(), b) },
    h('span.swap', icon('Copy', 16), icon('Check', 16)), label && h('span', label));
  return b;
}

// --- Sounds (WebAudio, leise) ----------------------------------------------
let actx;
export function sound(kind) {
  if (!cfg.settings.sounds) return;
  try {
    actx ||= new AudioContext();
    const notes = { join: [587, 880], chat: [988], control: [523, 784], leave: [660, 440], request: [880, 1175] }[kind] || [660];
    notes.forEach((f, i) => {
      const o = actx.createOscillator();
      const g = actx.createGain();
      const t = actx.currentTime + i * 0.08;
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.05, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      o.connect(g).connect(actx.destination);
      o.start(t);
      o.stop(t + 0.24);
    });
  } catch {
    /* Audio optional */
  }
}

/** Links im Chat klickbar machen – ohne innerHTML. */
export function linkify(text, open) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"]+/g)) {
    out.push(text.slice(last, m.index));
    const url = m[0];
    out.push(h('a', { href: url, onclick: (e) => { e.preventDefault(); open(url); } }, url));
    last = m.index + url.length;
  }
  out.push(text.slice(last));
  return out;
}
