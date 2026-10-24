import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './vendor/i18n.js';
import './locales/en.js';
import './locales/de.js';
import './locales/tr.js';
import './vendor/language-picker.js';
import './vendor/language-picker.css';
import './vendor/update-dialog.js';
import './vendor/update-dialog.css';
import './styles/app.css';

import { call, isTauri, isWeb, on, win } from './lib/bridge.js';
import { host } from './lib/host.js';
import { updateBeacon } from './lib/lan.js';
import { fmtCode, net } from './lib/net.js';
import { applyTheme, cfg, collect, emit, loadConfig, log, onEvent, setProfile, upsertFriend } from './lib/store.js';
import { avatar, h, icon, mount, sound, t, toast, transition } from './lib/ui.js';
import { viewer } from './lib/viewer.js';
import { joinView } from './views/join.js';
import { sessionView } from './views/session.js';
import { settingsView } from './views/settings.js';
import { openSetup } from './views/setup.js';
import { shareView } from './views/share.js';

const I18n = window.I18n;

async function boot() {
  I18n.init();
  // Linux-WebKitGTK ohne WebRTC → Oberfläche im Browser (siehe web.rs)
  if (isTauri && typeof RTCPeerConnection === 'undefined') return browserMode();
  await loadConfig();
  applyTheme();
  const info = await call('sys_info').catch(() => ({}));
  if (!cfg.profile.name) setProfile({ name: (info.hostname || t('setup.defaultName')).slice(0, 32) });
  call('set_close_to_tray', { enabled: cfg.settings.closeToTray }).catch(() => {});
  net.start();
  renderShell();
  wireEvents();
  startUpdates(info.version);
  if (!cfg.setupDone) openSetup();
  log(`Screen-Clean ${info.version || ''} gestartet (${isTauri ? info.os : isWeb ? `${info.os}, Browser-Modus` : 'Browser'})`);
  // Fenster erst zeigen, wenn alles gezeichnet ist – kein Aufblitzen
  await document.fonts?.ready;
  requestAnimationFrame(() => requestAnimationFrame(() => call('app_ready').catch(() => {})));
}

function browserMode() {
  const start = () => call('web_start').catch((e) => toast(t('browser.failed', { error: String(e) }), { type: 'error' }));
  mount(document.getElementById('app'), h('div.browser-mode.stagger',
    h('img', { src: '/logo.svg', alt: '', width: 64, height: 64 }),
    h('h1.title', t('browser.title')),
    h('p.lead', t('browser.text')),
    h('button.btn.primary.lg', { onclick: start }, icon('Globe', 17), t('browser.open'))));
  start();
}

/** Update-Fenster: prüft GitHub Releases über das Rust-Backend (signiertes latest.json). */
function startUpdates(version) {
  if (!isTauri && !isWeb) return; // reiner Browser (Entwicklung): kein Installer zum Aktualisieren
  const adapter = {
    mode: 'desktop',
    check: () => call('update_check'),
    async install(onProgress) {
      const off = await on('update:progress', onProgress);
      try {
        await call('update_install');
      } finally {
        off();
      }
    },
  };
  window.UpdateUI.init({ adapter, currentVersion: version || '' });
}

// --- Shell -------------------------------------------------------------------
const NAV = [
  ['share', 'nav.share', 'ScreenShare'],
  ['join', 'nav.join', 'LogIn'],
  ['settings', 'nav.settings', 'Settings'],
];

function renderShell() {
  const app = document.getElementById('app');
  let views;
  let subs = [];
  const buildViews = () => {
    subs.forEach((off) => off());
    [views, subs] = collect(() => ({ share: shareView(), join: joinView(), settings: settingsView() }));
  };
  buildViews();
  const session = sessionView();
  const content = h('main.content');
  const pill = h('span.nav-pill');
  const items = Object.fromEntries(NAV.map(([id, , ic]) => [id, h('button.nav-item', { type: 'button', onclick: () => nav(id) }, icon(ic, 18), h('span'))]));
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

  function paintLabels() {
    for (const [id, key] of NAV) items[id].querySelector('span').textContent = t(key);
    call('tray_labels', { show: t('tray.show'), stop: t('tray.stop'), quit: t('tray.quit') }).catch(() => {});
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
        h('div.row-main', h('span.row-title', viewer.host?.name || fmtCode(viewer.code)), h('span.row-sub', viewer.state === 'live' ? t('side.backToSession') : t('session.connecting'))),
        icon('ChevronRight', 16))
      : null);
  }

  const paintStatus = () => {
    const [cls, key] = { online: ['ok', 'status.online'], connecting: ['warn', 'status.connecting'], busy: ['warn', 'status.busy'], error: ['bad', 'status.error'], offline: ['bad', 'status.offline'] }[net.state];
    mount(status, h(`span.dot.${cls}`), t(key), net.state === 'online' ? h('span.mono.faint', { style: { marginInlineStart: 'auto' } }, fmtCode(cfg.code)) : null);
    status.title = net.error ? t(net.error) : '';
  };
  const paintMe = () => mount(me, avatar(cfg.profile.name, cfg.profile.color, 30), h('div.row-main', h('span.row-title', cfg.profile.name), h('span.row-sub', t('side.profile'))));

  // Sprachwechsel: Hauptansichten neu aufbauen (Zustand liegt in lib/), Session bleibt
  I18n.onChange(() => {
    buildViews();
    const was = current;
    current = '';
    mount(content, views[was || 'share']);
    current = was || 'share';
    paintLabels();
    paintNav();
    paintSide();
    paintStatus();
    paintMe();
    emit('lang');
  });

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
  paintLabels();
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
      h('button.btn.sm.ghost', { type: 'button', onclick: done(deny) }, t('req.decline')),
      trust && h('button.btn.sm', { type: 'button', 'data-tip': t('req.always.tip'), onclick: done(trust) }, t('req.alwaysAllow')),
      h('button.btn.sm.primary', { type: 'button', onclick: done(accept) }, t('req.accept'))),
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
    notifyIfHidden(t('notify.join.title'), t('notify.join.body', { name: r.name }));
    cards.get(r.id)?.();
    cards.set(r.id, requestCard({
      who: r.name, color: r.color, text: t('req.watch', { code: fmtCode(r.code) }), ms: 60_000,
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
    notifyIfHidden(t('notify.control.title'), t('notify.control.body', { name: v.name }));
    requestCard({ who: v.name, color: v.color, text: t('req.control'), accept: () => host.setController(v.id), deny: () => host.denyControl(v.id) });
  });
  onEvent('host:join', (v) => { sound('join'); toast(t('toast.joined', { name: v.name }), { icon: 'Eye' }); });
  onEvent('host:leave', (v) => { sound('leave'); toast(t('toast.left', { name: v.name }), { icon: 'LogOut', ms: 2400 }); });
  let waiting;
  onEvent('host:need-share', () => {
    notifyIfHidden(t('notify.waiting.title'), t('notify.waiting.body'));
    waiting?.();
    waiting = toast(t('toast.waiting'), { icon: 'ScreenShare', ms: 8000, action: { label: t('nav.share'), run: () => host.startShare() } });
  });
  onEvent('host:share', (active) => active && waiting?.());
  onEvent('host:share-error', (e) => e?.name !== 'NotAllowedError' && toast(t('toast.shareFailed', { error: e?.message || String(e) }), { type: 'error' }));
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
    if (was) toast(t('toast.brake'), { type: 'warn', icon: 'Shield' });
  });
  // Beenden: alle sauber verabschieden, damit niemand ins Leere neu verbindet
  on('app:quit', () => {
    host.broadcast({ t: 'host-stop' });
    viewer.leave();
  });
  // Browser-Modus: Tray „Öffnen“ holt dieses Fenster nach vorn statt ein zweites zu öffnen
  on('app:focus', () => window.focus());

  document.addEventListener('contextmenu', (e) => !e.target.closest('input, textarea, .selectable, .chat-list') && e.preventDefault());
  updateBeacon();
}

boot().catch((e) => {
  console.error(e);
  document.getElementById('app').textContent = `Startfehler: ${e}`;
  call('app_ready').catch(() => {});
});
