// Zuschauen: Stream, farbige Cursor, Fernsteuerung, Chat, Diagnose.
import { win } from '../lib/bridge.js';
import { fmtCode, net } from '../lib/net.js';
import { cfg, emit, findFriend, onEvent, upsertFriend } from '../lib/store.js';
import { fmtRate } from '../lib/stats.js';
import { avatar, h, icon, mount, sound, t, toast } from '../lib/ui.js';
import { viewer } from '../lib/viewer.js';
import { chatPanel } from './chat.js';
import { cursorLabel, cursorLayer, seg } from './controls.js';

const MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'OS']);
const COMBOS = [
  ['combo.switch', ['Alt', 'Tab'], () => 'Alt Tab'],
  ['combo.start', ['Meta'], () => 'Win'],
  ['combo.desktop', ['Meta', 'd'], () => 'Win D'],
  ['combo.taskmgr', ['Control', 'Shift', 'Escape'], () => `${t('kbd.ctrl')} ⇧ Esc`],
  ['combo.close', ['Alt', 'F4'], () => 'Alt F4'],
  ['combo.screenshot', ['PrintScreen'], () => t('kbd.print')],
];

export function sessionView() {
  const video = h('video', { autoplay: true, playsInline: true });
  const cursorLayer_ = h('div.cursor-layer');
  const reactLayer = h('div.react-layer');
  const msg = h('div.stage-msg');
  const stage = h('div.stage', { tabindex: 0, 'aria-label': t('session.stage') }, video, cursorLayer_, reactLayer, msg);
  const top = h('div.s-top');
  const dock = h('div.s-dock.glass');
  const hud = h('div.hud.glass', { hidden: !cfg.settings.diagnostics });
  const panel = h('aside.s-panel.glass', { hidden: true });
  const el = h('section.session', stage, top, dock, hud, panel);
  let tab = 'chat';
  let unread = 0;
  let muted = false;

  // --- Video-Geometrie (object-fit: contain → Letterbox beachten) ----------
  function contentRect() {
    const r = video.getBoundingClientRect();
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return r;
    const s = Math.min(r.width / vw, r.height / vh);
    const w = vw * s;
    const hh = vh * s;
    return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - hh) / 2, width: w, height: hh };
  }
  function fitLayers() {
    const c = contentRect();
    const s = stage.getBoundingClientRect();
    for (const layer of [cursorLayer_, reactLayer]) {
      Object.assign(layer.style, { left: `${c.left - s.left}px`, top: `${c.top - s.top}px`, width: `${c.width}px`, height: `${c.height}px` });
    }
  }
  new ResizeObserver(fitLayers).observe(stage);
  video.addEventListener('resize', fitLayers);
  video.addEventListener('loadedmetadata', fitLayers);

  function norm(e) {
    const c = contentRect();
    const x = (e.clientX - c.left) / c.width;
    const y = (e.clientY - c.top) / c.height;
    return x >= 0 && x <= 1 && y >= 0 && y <= 1 && video.videoWidth ? { x: +x.toFixed(5), y: +y.toFixed(5) } : null;
  }

  // --- Maus ----------------------------------------------------------------
  let inside = false;
  stage.addEventListener('pointermove', (e) => {
    wake();
    const p = norm(e);
    if (!p) {
      if (inside) viewer.cursor(null, null);
      inside = false;
      return;
    }
    inside = true;
    viewer.cursor(p.x, p.y);
    viewer.input({ k: 'move', ...p });
  });
  stage.addEventListener('pointerleave', () => {
    if (inside) viewer.cursor(null, null);
    inside = false;
  });
  stage.addEventListener('pointerdown', (e) => {
    stage.focus({ preventScroll: true });
    closePopovers();
    const p = norm(e);
    if (!viewer.controlling || !p) return;
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    viewer.input({ k: 'move', ...p });
    viewer.input({ k: 'btn', b: e.button, down: true });
  });
  stage.addEventListener('pointerup', (e) => {
    if (!viewer.controlling) return;
    e.preventDefault();
    viewer.input({ k: 'btn', b: e.button, down: false });
  });
  stage.addEventListener('contextmenu', (e) => viewer.controlling && e.preventDefault());
  let wy = 0;
  let wx = 0;
  stage.addEventListener('wheel', (e) => {
    if (!viewer.controlling) return;
    e.preventDefault();
    const f = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 300 : 1;
    wy += e.deltaY * f;
    wx += e.deltaX * f;
    const dy = Math.trunc(wy / 100);
    const dx = Math.trunc(wx / 100);
    if (dy || dx) {
      wy -= dy * 100;
      wx -= dx * 100;
      viewer.input({ k: 'wheel', dx, dy });
    }
  }, { passive: false });

  // --- Tastatur ------------------------------------------------------------
  const mods = (e) => {
    const altgr = e.getModifierState('AltGraph');
    return [e.ctrlKey && !altgr, e.shiftKey, e.altKey && !altgr, e.metaKey];
  };
  function onKey(e, down) {
    if (!viewer.controlling) return;
    e.preventDefault();
    const m = mods(e);
    if (MODIFIERS.has(e.key)) return viewer.input({ k: 'mods', m });
    if (e.key === 'Dead' || e.key === 'Unidentified' || e.isComposing) return;
    const shortcut = m[0] || m[2] || m[3];
    if (e.key.length === 1 && !/^[a-z0-9 ]$/i.test(e.key) && !shortcut) {
      // Sonderzeichen/Umlaute/AltGr: layout-unabhängig als Text
      if (down) viewer.input({ k: 'text', s: e.key });
      return;
    }
    viewer.input({ k: 'key', key: e.key.length === 1 ? e.key.toLowerCase() : e.key, down, m });
  }
  stage.addEventListener('keydown', (e) => onKey(e, true));
  stage.addEventListener('keyup', (e) => onKey(e, false));
  stage.addEventListener('blur', () => viewer.controlling && viewer.input({ k: 'mods', m: [false, false, false, false] }));

  // --- Cursor der anderen ----------------------------------------------------
  // Liegt das Host-Overlay im Stream (Linux), sind die Cursor schon im Bild.
  const others = cursorLayer(cursorLayer_);
  function paintCursors() {
    const show = cfg.settings.remoteCursors && !viewer.overlayInCapture;
    const byId = new Map(viewer.list.map((p) => [p.id, p]));
    const list = [];
    if (show) {
      for (const [id, c] of viewer.cursors) {
        const p = byId.get(id);
        if (p && c.x != null) list.push({ id, x: c.x, y: c.y, name: cursorLabel(p.name, viewer.cursorNames), color: p.color });
      }
    }
    others.sync(list);
  }

  function floatReaction({ emoji, name, color }) {
    const f = h('div.floater', { style: { left: `${12 + Math.random() * 76}%`, '--c': color } }, h('span.emoji', emoji), h('span.who', name));
    reactLayer.append(f);
    setTimeout(() => f.remove(), 2700);
  }

  // --- Auto-Ausblenden der Bedienelemente -----------------------------------
  let idleTimer;
  function wake() {
    el.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const busy = !panel.hidden || dock.matches(':hover') || dock.querySelector('.popover');
      if (viewer.state === 'live' && viewer.stream && !busy) el.classList.add('idle');
    }, 2800);
  }

  // --- Oberleiste & Dock -----------------------------------------------------
  const tbtn = (ic, tip, onclick, cls = '') => h(`button.icon-btn${cls}`, { type: 'button', 'data-tip': tip, 'aria-label': tip, onclick }, icon(ic, 19));
  const statusText = () => {
    if (viewer.state === 'live') {
      if (viewer.controlling) return t('session.youControl');
      const s = viewer.stats;
      return s?.fps ? `${s.fps} FPS · ${s.ping ?? '–'} ms` : t('session.connected');
    }
    return { connecting: t('session.connecting'), waiting: t('session.waiting'), reconnecting: t('session.reconnecting'), ended: t('session.disconnected') }[viewer.state] || '';
  };

  function paintTop() {
    const name = viewer.host?.name || fmtCode(viewer.code);
    mount(top, h('div.host-chip.glass',
      h('button.icon-btn.tip-down', { type: 'button', 'aria-label': t('session.backToApp.label'), 'data-tip': t('session.backToApp'), onclick: () => emit('nav', 'app') }, icon('ChevronLeft', 19)),
      viewer.host ? avatar(viewer.host.name, viewer.host.color, 28) : null,
      h('div', h('b', name), h('div.sub', statusText()))));
  }

  function paintDock() {
    const live = viewer.state === 'live';
    if (!live) {
      mount(dock, tbtn('Maximize', t('session.fullscreen'), toggleFullscreen), h('span.divider'), tbtn('LogOut', t('session.leave'), leave, '.danger'));
      return;
    }
    const isFriend = !!findFriend(viewer.code);
    const ctl = !viewer.sharing ? null
      : viewer.controlling ? h('button.btn.ctl.on', { type: 'button', onclick: () => viewer.releaseControl() }, icon('Gamepad2', 17), t('session.release'))
        : viewer.ctlPending ? h('button.btn', { type: 'button', disabled: true }, h('span.spinner'), t('session.requested'))
          : h('button.btn', { type: 'button', onclick: () => viewer.requestControl() }, icon('Gamepad2', 17), t('session.control'));
    mount(dock,
      ctl, ctl && h('span.divider'),
      h('span.badge-wrap', tbtn('MessageCircle', t('chat.title'), () => openPanel('chat'), !panel.hidden && tab === 'chat' ? '.on' : ''), unread ? h('span.count', unread > 9 ? '9+' : unread) : null),
      tbtn('Users', t('share.people'), () => openPanel('people'), !panel.hidden && tab === 'people' ? '.on' : ''),
      keysMenu(),
      tbtn(muted ? 'VolumeX' : 'Volume2', muted ? t('session.unmute') : t('session.mute'), () => { muted = !muted; video.muted = muted; paintDock(); }, '.hide-sm'),
      tbtn('Activity', t('session.diagnostics'), () => { hud.hidden = !hud.hidden; paintHud(); paintDock(); }, `${hud.hidden ? '' : '.on'}.hide-sm`),
      tbtn(el.classList.contains('immersive') ? 'Minimize' : 'Maximize', t('session.fullscreen'), toggleFullscreen, '.hide-sm'),
      tbtn('Star', isFriend ? t('session.friendSaved') : t('people.saveFriend'), () => {
        upsertFriend(viewer.code, viewer.host?.name);
        toast(t('session.savedToast', { name: viewer.host?.name || 'Host' }), { type: 'ok', icon: 'Star' });
        paintDock();
      }, isFriend ? '.on' : ''),
      h('span.divider'),
      tbtn('LogOut', t('session.leave'), leave, '.danger'));
  }

  function keysMenu() {
    const wrap = h('span.pop-wrap');
    const b = tbtn('Keyboard', t('session.keys'), (e) => {
      e.stopPropagation();
      const open = wrap.querySelector('.popover');
      if (open) return open.remove();
      wrap.append(h('div.popover.glass',
        h('div.pop-title', t('session.keys.title')),
        COMBOS.map(([label, keys, kb]) => h('button.pop-item', { type: 'button', onclick: () => { viewer.input({ k: 'combo', keys }); closePopovers(); } }, t(label), h('kbd', kb())))));
    });
    b.disabled = !viewer.controlling;
    wrap.append(b);
    return wrap;
  }
  const closePopovers = () => el.querySelectorAll('.popover').forEach((p) => p.remove());

  function leave() {
    viewer.leave();
    emit('nav', 'join');
  }

  async function toggleFullscreen() {
    const on = !el.classList.contains('immersive');
    el.classList.toggle('immersive', on);
    await win.fullscreen(on).catch(() => {});
    paintDock();
  }

  // --- Panel (Chat / Personen) ----------------------------------------------
  const chat = chatPanel({
    messages: () => viewer.chat,
    send: (t) => viewer.sendChat(t),
    react: (e) => viewer.react(e),
    isMine: (m) => m?.from === net.id,
    event: 'viewer:chat',
  });
  const people = h('div.people');
  const makeTabs = () => seg([['chat', t('chat.title')], ['people', t('share.people')]], tab, (v) => { tab = v; paintPanel(); paintDock(); });
  let tabs = makeTabs();
  const closeBtn = () => tbtn('X', t('common.close'), () => { panel.hidden = true; paintDock(); });
  const panelBody = h('div.panel-body');
  const panelHead = h('div.panel-head', tabs, closeBtn());
  panel.append(panelHead, panelBody);

  function openPanel(next) {
    if (!panel.hidden && tab === next) panel.hidden = true;
    else {
      panel.hidden = false;
      tab = next;
      tabs.set(next);
    }
    paintPanel();
    paintDock();
    if (!panel.hidden && tab === 'chat') chat.focusInput();
  }

  function paintPanel() {
    if (panel.hidden) return;
    if (tab === 'chat') unread = 0;
    const want = tab === 'chat' ? chat : people;
    if (panelBody.firstChild !== want) mount(panelBody, want);
    if (tab === 'people') paintPeople();
  }

  function paintPeople() {
    const host = viewer.host;
    mount(people, h('div',
      host && h('div.row.has-avatar', avatar(host.name, host.color, 32), h('div.row-main', h('span.row-title', host.name), h('span.row-sub', t('people.hostSharing'))), h('span.badge', icon('Crown', 12), t('people.host'))),
      viewer.list.map((p) => h('div.row.has-avatar',
        avatar(p.name, p.color, 32),
        h('div.row-main', h('span.row-title', p.name, p.id === net.id ? h('span.row-sub', ` · ${t('people.you')}`) : ''), h('span.row-sub.num', p.rtt != null ? `${p.rtt} ms` : t('people.watching'))),
        p.ctl && h('span.badge.amber', icon('Gamepad2', 12), t('people.controls'))))));
  }

  // --- Diagnose ---------------------------------------------------------------
  const history = [];
  function paintHud() {
    if (hud.hidden) return;
    const s = viewer.stats;
    if (!s) return mount(hud);
    history.push(s.kbps);
    if (history.length > 40) history.shift();
    const max = Math.max(1000, ...history);
    const pts = history.map((v, i) => `${(i / 39) * 120},${30 - (v / max) * 27}`).join(' ');
    const good = (s.ping ?? 0) < 80 && s.loss < 2;
    mount(hud,
      h('div.hud-h', h(`span.dot.${good ? 'ok' : 'warn'}`), t('hud.title')),
      h('div.hud-grid', [
        ['FPS', s.fps], [t('hud.bitrate'), fmtRate(s.kbps)], ['Ping', s.ping != null ? `${s.ping} ms` : '–'], [t('hud.loss'), `${s.loss.toFixed(1)} %`],
        [t('hud.resolution'), s.width ? `${s.width}×${s.height}` : '–'], ['Codec', s.codec || '–'], ['Decoder', s.encoder || '–'], [t('hud.route'), s.route ? t(`route.${s.route}`) : '–'],
      ].map(([k, v]) => [h('span.k', k), h('span.v', String(v))])),
      spark(pts));
  }
  function spark(pts) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 120 32');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.classList.add('spark');
    const pl = document.createElementNS(ns, 'polyline');
    pl.setAttribute('points', pts);
    svg.append(pl);
    return svg;
  }

  // --- Zustandsmeldungen -------------------------------------------------------
  let countdown;
  function paintMsg() {
    clearInterval(countdown);
    const s = viewer.state;
    const code = fmtCode(viewer.code);
    const box = (visual, title, text, ...actions) =>
      mount(msg, h('div.msg-box', visual, h('h2', title), text && h('p', text), actions.length ? h('div.row-actions', actions) : null));
    const cancel = () => h('button.btn.ghost', { type: 'button', onclick: leave }, t('common.cancel'));
    msg.hidden = false;
    el.dataset.state = s;
    if (s === 'connecting') return box(h('div.orbit'), t('session.msg.connecting', { code }), t('session.msg.connecting.text'), cancel());
    if (s === 'waiting') return box(h('div.orbit'), t('session.msg.waiting'), t('session.msg.waiting.text', { code }), cancel());
    if (s === 'reconnecting') {
      const tick = () => {
        const left = Math.max(0, Math.ceil((viewer.info.at - Date.now()) / 1000));
        box(h('div.orbit.warn'), t('session.msg.interrupted'), t(left ? 'session.msg.retryIn' : 'session.msg.retryNow', { reason: t(viewer.info.reason), seconds: left, attempt: viewer.info.attempt, max: viewer.info.max }),
          h('button.btn.primary', { type: 'button', onclick: () => viewer.retryNow() }, icon('RefreshCw', 16), t('session.tryNow')), cancel());
      };
      tick();
      countdown = setInterval(tick, 1000);
      return;
    }
    if (s === 'ended') {
      const c = viewer.code;
      return box(h('div.msg-icon', icon('X', 26)), t('session.msg.ended'), t(viewer.info.reason, { detail: t(viewer.info.detail || '') }),
        h('button.btn.primary', { type: 'button', onclick: () => { const err = viewer.join(c); if (err) toast(t(err), { type: 'warn' }); } }, icon('RefreshCw', 16), t('session.reconnect')),
        h('button.btn.ghost', { type: 'button', onclick: () => { viewer.setState('idle'); emit('nav', 'join'); } }, t('common.close')));
    }
    if (s === 'live' && !viewer.sharing) return box(h('div.msg-icon', icon('MonitorUp', 26)), t('session.msg.notSharing', { name: viewer.host?.name || code }), t('session.msg.notSharing.text'));
    if (s === 'live' && !viewer.stream) return box(h('div.orbit'), t('session.msg.starting'), null);
    if (s === 'live' && viewer.paused) return box(h('div.msg-icon', icon('Pause', 26)), t('share.paused'), t('session.msg.paused.text', { name: viewer.host?.name || '' }));
    msg.hidden = true;
  }

  // --- Ereignisse ----------------------------------------------------------------
  const repaint = () => {
    paintTop();
    paintDock();
    paintMsg();
    paintPanel();
  };
  onEvent('viewer:state', (st) => {
    if (st.state === 'live') {
      chat.refresh();
      if (cfg.settings.diagnostics) hud.hidden = false;
    }
    if (st.state === 'idle') el.classList.remove('immersive');
    repaint();
    wake();
  });
  onEvent('viewer:stream', (s) => {
    if (video.srcObject !== s) video.srcObject = s;
    if (s) {
      video.play().catch(() => {
        // Autoplay mit Ton blockiert → stumm starten, Ton per Klick
        muted = video.muted = true;
        video.play().catch(() => {});
        toast(t('session.autoplayMuted'), { icon: 'VolumeX' });
        paintDock();
      });
    }
    repaint();
  });
  onEvent('viewer:share', repaint);
  onEvent('viewer:participants', () => {
    paintTop();
    paintDock();
    paintPanel();
    paintCursors();
  });
  onEvent('viewer:cursors', paintCursors);
  onEvent('viewer:control', () => {
    if (viewer.controlling) {
      sound('control');
      toast(t('session.controlToast'), { type: 'ok', icon: 'Gamepad2' });
      stage.focus({ preventScroll: true });
    }
    el.classList.toggle('controlling', viewer.controlling);
    paintTop();
    paintDock();
  });
  onEvent('viewer:notice', (key) => toast(t(key), { type: 'warn' }));
  onEvent('viewer:react', floatReaction);
  onEvent('viewer:chat', (m) => {
    if (!m) return;
    const visible = !panel.hidden && tab === 'chat';
    if (m.from !== net.id && !visible) {
      unread++;
      sound('chat');
      toast(`${m.name}: ${m.text.slice(0, 80)}`, { icon: 'MessageCircle', action: { label: t('common.open'), run: () => openPanel('chat') } });
      paintDock();
    }
  });
  onEvent('viewer:stats', () => {
    paintHud();
    const sub = top.querySelector('.sub');
    if (sub) sub.textContent = statusText();
  });
  onEvent('settings', ({ key }) => {
    if (key === 'remoteCursors') paintCursors();
    if (key === 'diagnostics') {
      hud.hidden = !cfg.settings.diagnostics;
      paintHud();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && el.classList.contains('immersive') && !viewer.controlling) toggleFullscreen();
  });
  document.addEventListener('click', closePopovers);
  onEvent('lang', () => {
    const next = makeTabs();
    tabs.replaceWith(next);
    tabs = next;
    panelHead.lastChild.replaceWith(closeBtn());
    stage.setAttribute('aria-label', t('session.stage'));
    repaint();
    paintHud();
  });

  repaint();
  return el;
}
