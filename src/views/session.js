// Zuschauen: Stream, farbige Cursor, Fernsteuerung, Chat, Diagnose.
import { win } from '../lib/bridge.js';
import { fmtCode, net } from '../lib/net.js';
import { cfg, emit, findFriend, onEvent, upsertFriend } from '../lib/store.js';
import { fmtRate } from '../lib/stats.js';
import { avatar, h, icon, mount, sound, toast } from '../lib/ui.js';
import { viewer } from '../lib/viewer.js';
import { chatPanel } from './chat.js';
import { cursorEl, seg } from './controls.js';

const MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'OS']);
const COMBOS = [
  ['Fenster wechseln', ['Alt', 'Tab'], 'Alt Tab'],
  ['Start-Menü', ['Meta'], 'Win'],
  ['Desktop anzeigen', ['Meta', 'd'], 'Win D'],
  ['Task-Manager', ['Control', 'Shift', 'Escape'], 'Strg ⇧ Esc'],
  ['Fenster schließen', ['Alt', 'F4'], 'Alt F4'],
  ['Bildschirmfoto', ['PrintScreen'], 'Druck'],
];

export function sessionView() {
  const video = h('video', { autoplay: true, playsInline: true });
  const cursorLayer = h('div.cursor-layer');
  const reactLayer = h('div.react-layer');
  const msg = h('div.stage-msg');
  const stage = h('div.stage', { tabindex: 0, 'aria-label': 'Geteilter Bildschirm' }, video, cursorLayer, reactLayer, msg);
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
    for (const layer of [cursorLayer, reactLayer]) {
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
  const cursorEls = new Map();
  function paintCursors() {
    const show = cfg.settings.remoteCursors && !viewer.overlayInCapture;
    const byId = new Map(viewer.list.map((p) => [p.id, p]));
    for (const [id, c] of show ? viewer.cursors : []) {
      const p = byId.get(id);
      if (!p || c.x == null) continue;
      let cur = cursorEls.get(id);
      const key = `${p.name}${p.color}${p.ctl}`;
      if (!cur || cur.dataset.key !== key) {
        cur?.remove();
        cur = cursorEl(p.name, p.color, p.ctl);
        cur.dataset.key = key;
        cursorLayer.append(cur);
        cursorEls.set(id, cur);
      }
      cur.style.left = `${c.x * 100}%`;
      cur.style.top = `${c.y * 100}%`;
    }
    for (const [id, cur] of cursorEls) {
      const c = viewer.cursors.get(id);
      if (!show || !c || c.x == null || !byId.has(id)) {
        cur.remove();
        cursorEls.delete(id);
      }
    }
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
      if (viewer.controlling) return 'Du steuerst';
      const s = viewer.stats;
      return s?.fps ? `${s.fps} FPS · ${s.ping ?? '–'} ms` : 'Verbunden';
    }
    return { connecting: 'Verbinde …', waiting: 'Wartet auf Freigabe', reconnecting: 'Verbinde neu …', ended: 'Getrennt' }[viewer.state] || '';
  };

  function paintTop() {
    const name = viewer.host?.name || fmtCode(viewer.code);
    mount(top, h('div.host-chip.glass',
      h('button.icon-btn.tip-down', { type: 'button', 'aria-label': 'Zur App – Session läuft weiter', 'data-tip': 'Zur App', onclick: () => emit('nav', 'app') }, icon('ChevronLeft', 19)),
      viewer.host ? avatar(viewer.host.name, viewer.host.color, 28) : null,
      h('div', h('b', name), h('div.sub', statusText()))));
  }

  function paintDock() {
    const live = viewer.state === 'live';
    if (!live) {
      mount(dock, tbtn('Maximize', 'Vollbild', toggleFullscreen), h('span.divider'), tbtn('LogOut', 'Trennen', leave, '.danger'));
      return;
    }
    const isFriend = !!findFriend(viewer.code);
    const ctl = !viewer.sharing ? null
      : viewer.controlling ? h('button.btn.ctl.on', { type: 'button', onclick: () => viewer.releaseControl() }, icon('Gamepad2', 17), 'Abgeben')
        : viewer.ctlPending ? h('button.btn', { type: 'button', disabled: true }, h('span.spinner'), 'Angefragt …')
          : h('button.btn', { type: 'button', onclick: () => viewer.requestControl() }, icon('Gamepad2', 17), 'Steuern');
    mount(dock,
      ctl, ctl && h('span.divider'),
      h('span.badge-wrap', tbtn('MessageCircle', 'Chat', () => openPanel('chat'), !panel.hidden && tab === 'chat' ? '.on' : ''), unread ? h('span.count', unread > 9 ? '9+' : unread) : null),
      tbtn('Users', 'Personen', () => openPanel('people'), !panel.hidden && tab === 'people' ? '.on' : ''),
      keysMenu(),
      tbtn(muted ? 'VolumeX' : 'Volume2', muted ? 'Ton an' : 'Stumm', () => { muted = !muted; video.muted = muted; paintDock(); }, '.hide-sm'),
      tbtn('Activity', 'Diagnose', () => { hud.hidden = !hud.hidden; paintHud(); paintDock(); }, `${hud.hidden ? '' : '.on'}.hide-sm`),
      tbtn(el.classList.contains('immersive') ? 'Minimize' : 'Maximize', 'Vollbild', toggleFullscreen, '.hide-sm'),
      tbtn('Star', isFriend ? 'Als Freund gespeichert' : 'Als Freund speichern', () => {
        upsertFriend(viewer.code, viewer.host?.name);
        toast(`${viewer.host?.name || 'Host'} gespeichert`, { type: 'ok', icon: 'Star' });
        paintDock();
      }, isFriend ? '.on' : ''),
      h('span.divider'),
      tbtn('LogOut', 'Trennen', leave, '.danger'));
  }

  function keysMenu() {
    const wrap = h('span.pop-wrap');
    const b = tbtn('Keyboard', 'Tastenkombination senden', (e) => {
      e.stopPropagation();
      const open = wrap.querySelector('.popover');
      if (open) return open.remove();
      wrap.append(h('div.popover.glass',
        h('div.pop-title', 'An den Host senden'),
        COMBOS.map(([label, keys, kb]) => h('button.pop-item', { type: 'button', onclick: () => { viewer.input({ k: 'combo', keys }); closePopovers(); } }, label, h('kbd', kb)))));
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
  const tabs = seg([['chat', 'Chat'], ['people', 'Personen']], tab, (v) => { tab = v; paintPanel(); paintDock(); });
  const panelBody = h('div.panel-body');
  panel.append(h('div.panel-head', tabs, tbtn('X', 'Schließen', () => { panel.hidden = true; paintDock(); })), panelBody);

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
      host && h('div.row.has-avatar', avatar(host.name, host.color, 32), h('div.row-main', h('span.row-title', host.name), h('span.row-sub', 'teilt seinen Bildschirm')), h('span.badge', icon('Crown', 12), 'Host')),
      viewer.list.map((p) => h('div.row.has-avatar',
        avatar(p.name, p.color, 32),
        h('div.row-main', h('span.row-title', p.name, p.id === net.id ? h('span.row-sub', '· du') : ''), h('span.row-sub.num', p.rtt != null ? `${p.rtt} ms` : 'zuschauend')),
        p.ctl && h('span.badge.amber', icon('Gamepad2', 12), 'steuert')))));
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
      h('div.hud-h', h(`span.dot.${good ? 'ok' : 'warn'}`), 'Verbindung'),
      h('div.hud-grid', [
        ['FPS', s.fps], ['Bitrate', fmtRate(s.kbps)], ['Ping', s.ping != null ? `${s.ping} ms` : '–'], ['Verlust', `${s.loss.toFixed(1)} %`],
        ['Auflösung', s.width ? `${s.width}×${s.height}` : '–'], ['Codec', s.codec || '–'], ['Decoder', s.encoder || '–'], ['Weg', s.route || '–'],
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
    const cancel = () => h('button.btn.ghost', { type: 'button', onclick: leave }, 'Abbrechen');
    msg.hidden = false;
    el.dataset.state = s;
    if (s === 'connecting') return box(h('div.orbit'), `Verbinde mit ${code}`, 'Direkte Verbindung wird aufgebaut.', cancel());
    if (s === 'waiting') return box(h('div.orbit'), 'Warte auf Freigabe', `${code} muss deine Anfrage bestätigen.`, cancel());
    if (s === 'reconnecting') {
      const tick = () => {
        const left = Math.max(0, Math.ceil((viewer.info.at - Date.now()) / 1000));
        box(h('div.orbit.warn'), 'Verbindung unterbrochen', `${viewer.info.reason}. Neuer Versuch ${left ? `in ${left} s` : 'läuft'} · ${viewer.info.attempt} von ${viewer.info.max}`,
          h('button.btn.primary', { type: 'button', onclick: () => viewer.retryNow() }, icon('RefreshCw', 16), 'Jetzt versuchen'), cancel());
      };
      tick();
      countdown = setInterval(tick, 1000);
      return;
    }
    if (s === 'ended') {
      const c = viewer.code;
      return box(h('div.msg-icon', icon('X', 26)), 'Session beendet', viewer.info.reason,
        h('button.btn.primary', { type: 'button', onclick: () => { const err = viewer.join(c); if (err) toast(err, { type: 'warn' }); } }, icon('RefreshCw', 16), 'Neu verbinden'),
        h('button.btn.ghost', { type: 'button', onclick: () => { viewer.setState('idle'); emit('nav', 'join'); } }, 'Schließen'));
    }
    if (s === 'live' && !viewer.sharing) return box(h('div.msg-icon', icon('MonitorUp', 26)), `${viewer.host?.name || code} teilt gerade nicht`, 'Du bist verbunden. Sobald geteilt wird, geht es hier los – der Chat läuft schon.');
    if (s === 'live' && !viewer.stream) return box(h('div.orbit'), 'Stream startet …', null);
    if (s === 'live' && viewer.paused) return box(h('div.msg-icon', icon('Pause', 26)), 'Pausiert', `${viewer.host?.name} hat die Übertragung kurz angehalten.`);
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
        toast('Ton ist aus – tipp auf den Lautsprecher', { icon: 'VolumeX' });
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
      toast('Du steuerst – Maus und Tastatur gehen an den Host.', { type: 'ok', icon: 'Gamepad2' });
      stage.focus({ preventScroll: true });
    }
    el.classList.toggle('controlling', viewer.controlling);
    paintTop();
    paintDock();
  });
  onEvent('viewer:notice', (t) => toast(t, { type: 'warn' }));
  onEvent('viewer:react', floatReaction);
  onEvent('viewer:chat', (m) => {
    if (!m) return;
    const visible = !panel.hidden && tab === 'chat';
    if (m.from !== net.id && !visible) {
      unread++;
      sound('chat');
      toast(`${m.name}: ${m.text.slice(0, 80)}`, { icon: 'MessageCircle', action: { label: 'Öffnen', run: () => openPanel('chat') } });
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

  repaint();
  return el;
}
