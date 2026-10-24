import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles/app.css';

import { call, isTauri, isWeb, on, win } from './lib/bridge.js';
import { host } from './lib/host.js';
import { updateBeacon } from './lib/lan.js';
import { fmtCode, net } from './lib/net.js';
import { applyTheme, cfg, emit, loadConfig, log, onEvent, setProfile, upsertFriend } from './lib/store.js';
import { avatar, h, icon, mount, sound, toast, transition } from './lib/ui.js';
import { viewer } from './lib/viewer.js';
import { joinView } from './views/join.js';
import { sessionView } from './views/session.js';
import { settingsView } from './views/settings.js';
import { openSetup } from './views/setup.js';
import { shareView } from './views/share.js';

async function boot() {
  // Linux-WebKitGTK ohne WebRTC → Oberfläche im Browser (siehe web.rs)
  if (isTauri && typeof RTCPeerConnection === 'undefined') return browserMode();
  await loadConfig();
  applyTheme();
  const info = await call('sys_info').catch(() => ({}));
  if (!cfg.profile.name) setProfile({ name: (info.hostname || 'Ich').slice(0, 32) });
  call('set_close_to_tray', { enabled: cfg.settings.closeToTray }).catch(() => {});
  net.start();
  renderShell();
  wireEvents();
  if (!cfg.setupDone) openSetup();
  log(`Screen-Clean ${info.version || ''} gestartet (${isTauri ? info.os : isWeb ? `${info.os}, Browser-Modus` : 'Browser'})`);
  // Fenster erst zeigen, wenn alles gezeichnet ist – kein Aufblitzen
  await document.fonts?.ready;
  requestAnimationFrame(() => requestAnimationFrame(() => call('app_ready').catch(() => {})));
}

function browserMode() {
  const start = () => call('web_start').catch((e) => toast(`Browser-Modus: ${e}`, { type: 'error' }));
  mount(document.getElementById('app'), h('div.browser-mode.stagger',
    h('img', { src: '/logo.svg', alt: '', width: 64, height: 64 }),
    h('h1.title', 'Screen-Clean öffnet sich im Browser'),
    h('p.lead', 'Das System-WebView kann hier keine Direktverbindungen (WebRTC). Die Oberfläche läuft deshalb in Chrome, Chromium oder deinem Standard-Browser – Tray, Tastenkürzel, Fernsteuerung und Cursor-Overlay bleiben in der App.'),
    h('button.btn.primary.lg', { onclick: start }, icon('Globe', 17), 'Im Browser öffnen')));
  start();
}

// --- Shell -------------------------------------------------------------------
const NAV = [
  ['share', 'Teilen', 'ScreenShare'],
  ['join', 'Beitreten', 'LogIn'],
  ['settings', 'Einstellungen', 'Settings'],
];

function renderShell() {
  const app = document.getElementById('app');
  const views = { share: shareView(), join: joinView(), settings: settingsView() };
  const session = sessionView();
  const content = h('main.content');
  const pill = h('span.nav-pill');
  const items = Object.fromEntries(NAV.map(([id, label, ic]) => [id, h('button.nav-item', { type: 'button', onclick: () => nav(id) }, icon(ic, 18), h('span', label))]));
  const sessionCard = h('div');
  const status = h('div.status');
  const me = h('button.me', { type: 'button', onclick: () => { nav('settings'); views.settings.open('general'); } });
  const sidebar = h('aside.sidebar',
    h('div.brand', h('img', { src: '/logo.svg', alt: '', width: 26, height: 26 }), 'Screen-Clean'),
    h('nav.side-nav', pill, Object.values(items)),
    sessionCard,
    h('div.side-foot', status, me));
  mount(app, sidebar, content);
  document.body.append(session);

  let current = '';
  let lastApp = 'share';
  function nav(to) {
    if (to === 'app') to = lastApp;
    if (to === 'session') {
      session.classList.add('open');
      paintSide();
      return;
    }
    if (session.classList.contains('open')) {
      session.classList.remove('open');
      if (session.classList.contains('immersive')) {
        session.classList.remove('immersive');
        win.fullscreen(false).catch(() => {});
      }
    }
    lastApp = to;
    if (to !== current) {
      const swap = () => {
        mount(content, views[to]);
        content.scrollTop = 0;
        current = to;
        paintNav();
      };
      current ? transition(swap) : swap();
    }
    if (to === 'join') setTimeout(() => views.join.focusInput(), 350);
    paintSide();
  }

  function paintNav() {
    for (const [id, el] of Object.entries(items)) el.classList.toggle('on', id === current);
    const active = items[current];
    if (active) pill.style.setProperty('--y', `${active.offsetTop}px`);
    // Live-Status direkt am Menüpunkt
    const share = items.share;
    share.querySelector('.count, .live-dot')?.remove();
    if (host.sharing) share.append(host.viewers.size ? h('span.count', host.viewers.size) : h('span.live-dot'));
    else if (host.pending.size) share.append(h('span.count', host.pending.size));
  }

  function paintSide() {
    const open = session.classList.contains('open');
    mount(sessionCard, viewer.active && !open
      ? h('button.side-session', { type: 'button', onclick: () => nav('session') },
        viewer.host ? avatar(viewer.host.name, viewer.host.color, 30) : h('span.spinner'),
        h('div.row-main', h('span.row-title', viewer.host?.name || fmtCode(viewer.code)), h('span.row-sub', viewer.state === 'live' ? 'Zurück zur Session' : 'Verbinde …')),
        icon('ChevronRight', 16))
      : null);
  }

  const paintStatus = () => {
    const [cls, label] = { online: ['ok', 'Online'], connecting: ['warn', 'Verbinde …'], busy: ['warn', 'Code belegt'], error: ['bad', 'Fehler'], offline: ['bad', 'Offline'] }[net.state];
    mount(status, h(`span.dot.${cls}`), label, net.state === 'online' ? h('span.mono.faint', { style: { marginLeft: 'auto' } }, fmtCode(cfg.code)) : null);
    status.title = net.error || '';
  };
  const paintMe = () => mount(me, avatar(cfg.profile.name, cfg.profile.color, 30), h('div.row-main', h('span.row-title', cfg.profile.name), h('span.row-sub', 'Profil & Einstellungen')));

  onEvent('nav', nav);
  onEvent('net', paintStatus);
  onEvent('code', paintStatus);
  onEvent('profile', paintMe);
  ['host:changed', 'host:share'].forEach((e) => onEvent(e, paintNav));
  onEvent('viewer:state', ({ state }) => {
    if (state === 'idle' && session.classList.contains('open')) nav('app');
    paintSide();
  });
  onEvent('viewer:participants', paintSide);
  onEvent('setup', () => openSetup());
  new ResizeObserver(paintNav).observe(sidebar);
  paintStatus();
  paintMe();
  nav('share');
}

// --- Anfragen-Karten (Beitritt / Steuerung) -----------------------------------
function requestCard({ who, color, text, accept, deny, trust, ms }) {
  const root = document.getElementById('requests');
  const done = (fn) => () => {
    fn?.();
    card.classList.add('out');
    setTimeout(() => card.remove(), 250);
  };
  const card = h('div.req-card', { role: 'alertdialog', 'aria-label': `${who}: ${text}` },
    h('div.req-top', avatar(who, color, 38), h('div.req-text', h('b', who), h('span', text))),
    h('div.req-actions',
      h('button.btn.sm.ghost', { type: 'button', onclick: done(deny) }, 'Ablehnen'),
      trust && h('button.btn.sm', { type: 'button', 'data-tip': 'Annehmen und künftig ohne Nachfrage', onclick: done(trust) }, 'Immer erlauben'),
      h('button.btn.sm.primary', { type: 'button', onclick: done(accept) }, 'Annehmen')),
    ms && h('span.timer', { style: { animationDuration: `${ms}ms` } }));
  root.append(card);
  return done();
}

function notifyIfHidden(title, body) {
  if (document.hasFocus()) return;
  call('notify', { title, body }).catch(() => {});
  win.attention();
}

// --- Globale Ereignisse ---------------------------------------------------------
function wireEvents() {
  const cards = new Map();
  onEvent('host:request', (r) => {
    sound('request');
    notifyIfHidden('Jemand möchte zuschauen', `${r.name} fragt nach deinem Bildschirm`);
    cards.get(r.id)?.();
    cards.set(r.id, requestCard({
      who: r.name, color: r.color, text: `möchte zuschauen · ${fmtCode(r.code)}`, ms: 60_000,
      accept: () => host.accept(r),
      deny: () => host.deny(r.id),
      trust: () => { upsertFriend(r.code, r.name, { trusted: true }); host.accept(r); },
    }));
  });
  // Karte schließen, wenn die Anfrage anderswo erledigt wurde
  onEvent('host:changed', () => {
    for (const [id, close] of cards) if (!host.pending.has(id)) { close(); cards.delete(id); }
  });
  onEvent('host:control-request', (v) => {
    sound('request');
    notifyIfHidden('Steuerungsanfrage', `${v.name} möchte Maus und Tastatur übernehmen`);
    requestCard({ who: v.name, color: v.color, text: 'möchte Maus und Tastatur übernehmen', accept: () => host.setController(v.id), deny: () => host.denyControl(v.id) });
  });
  onEvent('host:join', (v) => { sound('join'); toast(`${v.name} ist dabei`, { icon: 'Eye' }); });
  onEvent('host:leave', (v) => { sound('leave'); toast(`${v.name} ist gegangen`, { icon: 'LogOut', ms: 2400 }); });
  let waiting;
  onEvent('host:need-share', () => {
    notifyIfHidden('Jemand wartet', 'Starte das Teilen, damit deine Zuschauer etwas sehen.');
    waiting?.();
    waiting = toast('Jemand wartet auf deinen Bildschirm', { icon: 'ScreenShare', ms: 8000, action: { label: 'Teilen', run: () => host.startShare() } });
  });
  onEvent('host:share', (on) => on && waiting?.());
  onEvent('host:share-error', (e) => e?.name !== 'NotAllowedError' && toast(`Teilen fehlgeschlagen: ${e?.message || e}`, { type: 'error' }));
  onEvent('host:chat', (m) => {
    if (m.from === 'host') return;
    sound('chat');
    notifyIfHidden(m.name, m.text.slice(0, 120));
  });

  on('app:log', ({ level, msg }) => log(msg, level, { fromRust: true }));
  // Notbremse aus Rust (Strg+Shift+X / Tray)
  on('app:stop', () => {
    const was = host.sharing || viewer.controlling;
    host.emergencyStop();
    if (viewer.controlling) viewer.releaseControl();
    if (was) toast('Notbremse: Steuerung entzogen, Teilen beendet', { type: 'warn', icon: 'Shield' });
  });
  // Beenden: alle sauber verabschieden, damit niemand ins Leere neu verbindet
  on('app:quit', () => {
    host.broadcast({ t: 'host-stop' });
    viewer.leave();
  });

  document.addEventListener('contextmenu', (e) => !e.target.closest('input, textarea, .selectable, .chat-list') && e.preventDefault());
  updateBeacon();
  emit('ready');
}

boot().catch((e) => {
  console.error(e);
  document.getElementById('app').textContent = `Startfehler: ${e}`;
  call('app_ready').catch(() => {});
});
