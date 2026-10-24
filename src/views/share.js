// „Teilen“: eigener Code, Bildschirm teilen, Live-Vorschau, Personen, Chat.
import { host } from '../lib/host.js';
import { fmtCode, net } from '../lib/net.js';
import { cfg, findFriend, onEvent, setSetting, upsertFriend } from '../lib/store.js';
import { fmtRate } from '../lib/stats.js';
import { avatar, button, confirmDialog, copyButton, h, icon, mount, stagger } from '../lib/ui.js';
import { chatPanel } from './chat.js';
import { codeTiles, seg } from './controls.js';

const NET = {
  online: ['ok', 'Bereit – du bist erreichbar'],
  connecting: ['warn', 'Verbinde mit dem Server …'],
  busy: ['warn', 'Code noch belegt – neuer Versuch …'],
  error: ['bad', 'Keine Verbindung möglich'],
  offline: ['bad', 'Offline'],
};

export function shareView() {
  const title = h('h1.view-title', 'Teilen');
  const sub = h('p.view-sub');
  const headActions = h('div.row-trail');
  const body = h('div');
  const root = h('section.view', h('header.view-head', h('div', title, sub), headActions), body);
  let mode = '';

  // --- dauerhafte Bausteine ------------------------------------------------
  const tiles = codeTiles(cfg.code, true);
  const netLine = h('div.net-line');
  const shareBtn = button('.btn.primary.xl.block', { icon: 'ScreenShare', label: 'Bildschirm teilen', onclick: () => start(shareBtn) });
  const preview = h('video', { autoplay: true, muted: true, playsInline: true });
  const previewWrap = h('div.preview-wrap');
  const chips = h('div.chips');
  const stageBar = h('div.stage-bar');
  const warn = h('div.warn-line', icon('TriangleAlert', 15), 'Ein Fenster wird geteilt – Fernsteuerung und Cursor-Overlay brauchen einen ganzen Bildschirm.');
  const people = h('div.list');
  const peopleCount = h('span.faint.num');
  const chat = chatPanel({
    messages: () => host.chat,
    send: (t) => host.sendChat(t),
    react: (e) => host.hostReact(e),
    isMine: (m) => m?.from === 'host',
    event: 'host:chat',
  });

  async function start(btn) {
    btn.loading(true);
    await host.startShare();
    btn.loading(false);
  }

  const segs = {};
  const policies = () => h('div.list.policies',
    h('div.row',
      h('div.row-main', h('span.row-title', 'Wer darf zuschauen'), h('span.row-sub', 'Vertraute Freunde kommen immer direkt rein')),
      (segs.joinPolicy = seg([['ask', 'Fragen'], ['friends', 'Freunde'], ['auto', 'Alle']], cfg.settings.joinPolicy, (v) => setSetting('joinPolicy', v)))),
    h('div.row',
      h('div.row-main', h('span.row-title', 'Fernsteuerung'), h('span.row-sub', 'Strg+Shift+X entzieht sie jederzeit')),
      (segs.controlPolicy = seg([['ask', 'Fragen'], ['auto', 'Erlauben'], ['deny', 'Aus']], cfg.settings.controlPolicy, (v) => setSetting('controlPolicy', v)))));

  // --- Layout je nach Zustand -------------------------------------------------
  function layout() {
    const next = host.sharing || host.viewers.size || host.pending.size ? 'live' : 'idle';
    if (next === mode) return;
    mode = next;
    if (mode === 'idle') {
      mount(headActions);
      mount(body, stagger(h('div.share-idle',
        h('div.card.code-card',
          h('span.eyebrow', 'DEIN CODE'),
          tiles,
          h('div.code-actions',
            copyButton(() => fmtCode(cfg.code), '.btn.sm', null, 'Kopieren'),
            h('button.btn.sm.ghost', { type: 'button', onclick: regenerate }, icon('RefreshCw', 15), 'Neu')),
          netLine),
        shareBtn,
        h('div.group', h('div.group-title', 'Freigabe'), policies()),
        h('p.faint', { style: { textAlign: 'center', fontSize: '12.5px' } }, 'Im selben WLAN taucht dein Gerät bei anderen automatisch auf.'))));
    } else {
      mount(headActions, h('span.badge.num', { style: { height: '28px', padding: '0 10px', fontSize: '13px' } }, h('span.mono', fmtCode(cfg.code))), copyButton(() => fmtCode(cfg.code), '.icon-btn', 'Code kopieren'));
      mount(previewWrap, preview, chips);
      mount(body, h('div.share-live',
        stagger(h('div.col.side-col', h('div.card.stage-card', previewWrap, stageBar, warn), h('div.group', h('div.group-title', 'Freigabe'), policies()))),
        stagger(h('div.side-col',
          h('div.group', h('div.group-title', 'Personen', peopleCount), people),
          h('div.group', h('div.group-title', 'Chat'), h('div.card', chat))))));
    }
  }

  function paintHead() {
    const n = host.viewers.size;
    sub.textContent = mode === 'idle'
      ? 'Gib deinen Code weiter – Freunde schauen zu oder steuern mit.'
      : host.sharing ? (host.paused ? 'Pausiert – niemand sieht deinen Bildschirm' : `Live · ${n ? `${n} ${n === 1 ? 'Person schaut' : 'Personen schauen'} zu` : 'Warte auf Zuschauer'}`)
        : `${n} verbunden – starte das Teilen, damit sie etwas sehen`;
    const [cls, text] = NET[net.state] || NET.offline;
    mount(netLine, h(`span.dot.${cls}`), net.error && net.state !== 'online' ? net.error : text,
      net.state === 'busy' ? h('button.link', { onclick: regenerate }, 'Neuen Code nehmen') : null);
  }

  function paintStage() {
    if (mode !== 'live') return;
    if (preview.srcObject !== host.stream) preview.srcObject = host.stream;
    previewWrap.classList.toggle('paused', host.paused);
    if (!host.sharing) {
      mount(previewWrap, h('div.preview-empty', icon('MonitorUp', 30), h('b', 'Noch nichts geteilt'), h('p', 'Deine Zuschauer sind verbunden. Wähl einen Bildschirm, sobald du bereit bist.'), shareBtn));
      mount(stageBar, h('span.enc.grow', ''));
      warn.hidden = true;
      return;
    }
    if (!previewWrap.contains(preview)) mount(previewWrap, preview, chips);
    previewWrap.querySelector('.paused-label')?.remove();
    if (host.paused) previewWrap.append(h('div.paused-label', icon('Pause', 18), 'Pausiert'));
    warn.hidden = host.shareKind === 'monitor';
    const pause = button('.btn', { icon: host.paused ? 'Play' : 'Pause', label: host.paused ? 'Fortsetzen' : 'Pausieren', onclick: () => host.pause(!host.paused) });
    const swap = button('.btn', { icon: 'Monitor', label: 'Quelle', tip: 'Anderen Bildschirm oder anderes Fenster wählen', onclick: async () => { swap.loading(true); await host.switchSource(); swap.loading(false); } });
    mount(stageBar, swap, pause, h('span.enc.grow'), button('.btn.danger', { icon: 'ScreenShareOff', label: 'Beenden', onclick: () => host.stopShare() }));
    paintStats();
  }

  function paintStats() {
    if (mode !== 'live' || !host.sharing) return;
    const s = [...host.viewers.values()].find((v) => v.stats)?.stats;
    const n = host.viewers.size;
    mount(chips,
      h('span.chip', h('span.live-dot'), host.paused ? 'Pausiert' : 'Live'),
      h('span.chip.num', icon('Eye', 14), n),
      s?.fps ? h('span.chip.right.num', `${s.fps} FPS · ${fmtRate(s.kbps)}`) : null);
    const enc = stageBar.querySelector('.enc');
    if (enc) enc.textContent = s ? [s.codec, s.encoder, s.limit && `begrenzt: ${{ bandwidth: 'Bandbreite', cpu: 'CPU' }[s.limit] || s.limit}`].filter(Boolean).join(' · ') : '';
  }

  // --- Personen ---------------------------------------------------------------
  const seen = new Set();
  function paintPeople() {
    if (mode !== 'live') return;
    const pending = [...host.pending.values()];
    const viewers = [...host.viewers.values()];
    peopleCount.textContent = viewers.length || '';
    const rows = [];
    for (const r of pending) {
      const elapsed = (Date.now() - r.at) / 1000;
      rows.push(keyed(`p:${r.id}`, h('div.row.req.has-avatar',
        avatar(r.name, r.color, 32),
        h('div.row-main', h('span.row-title', r.name), h('span.row-sub', `möchte zuschauen · ${fmtCode(r.code)}`)),
        h('div.row-trail',
          h('button.btn.sm.ghost', { onclick: () => host.deny(r.id) }, 'Ablehnen'),
          h('button.btn.sm', { 'data-tip': 'Annehmen und künftig ohne Nachfrage', onclick: () => { upsertFriend(r.code, r.name, { trusted: true }); host.accept(r); } }, 'Immer'),
          h('button.btn.sm.primary', { onclick: () => host.accept(r) }, 'Annehmen')),
        h('span.timer', { style: { animationDuration: '60s', animationDelay: `-${elapsed}s` } }))));
    }
    for (const v of viewers) {
      const ctl = host.controller === v.id;
      const s = v.stats;
      const canCtl = host.sharing && host.shareKind === 'monitor';
      rows.push(keyed(`v:${v.id}`, h('div.row.hover.has-avatar',
        avatar(v.name, v.color, 32),
        h('div.row-main',
          h('span.row-title', v.name, ctl && h('span.badge.amber', icon('Gamepad2', 12), 'steuert')),
          h('span.row-sub.num', [v.rtt != null && `${v.rtt} ms`, s?.fps && `${s.fps} FPS`, s?.route].filter(Boolean).join(' · ') || fmtCode(v.code))),
        h('div.row-trail',
          h(`button.icon-btn${ctl ? '.on' : ''}`, { 'data-tip': ctl ? 'Steuerung entziehen' : 'Steuerung geben', disabled: !canCtl, onclick: () => host.setController(ctl ? null : v.id) }, icon('Gamepad2', 17)),
          h(`button.icon-btn${findFriend(v.code) ? '.on' : ''}`, { 'data-tip': findFriend(v.code) ? 'Gespeichert' : 'Als Freund speichern', onclick: () => { upsertFriend(v.code, v.name); paintPeople(); } }, icon('Star', 17)),
          h('button.icon-btn.danger', { 'data-tip': 'Entfernen', onclick: () => host.kick(v.id) }, icon('X', 17))))));
    }
    if (!rows.length) rows.push(h('div.empty', icon('Users', 24), h('b', 'Noch niemand da'), h('span', `Gib deinen Code ${fmtCode(cfg.code)} weiter.`)));
    mount(people, rows);
  }
  function keyed(key, el) {
    if (!seen.has(key)) {
      el.classList.add('enter');
      seen.add(key);
    }
    return el;
  }

  async function regenerate() {
    const ok = await confirmDialog({ title: 'Neuen Code erzeugen?', text: 'Wer deinen alten Code gespeichert hat, findet dich danach nicht mehr.', ok: 'Neuer Code' });
    if (ok) net.regenerate();
  }

  const paint = () => {
    layout();
    paintHead();
    paintStage();
    paintPeople();
  };
  ['host:changed', 'host:share', 'net'].forEach((e) => onEvent(e, paint));
  onEvent('host:stats', () => {
    paintStats();
    paintPeople();
  });
  onEvent('code', () => {
    tiles.set(cfg.code);
    paintHead();
  });
  onEvent('friends', paintPeople);
  onEvent('settings', ({ key }) => segs[key]?.set(cfg.settings[key]));
  paint();
  return root;
}
