// „Teilen“: eigener Code, Bildschirm teilen, Live-Vorschau, Personen, Chat.
import { host } from '../lib/host.js';
import { fmtCode, net } from '../lib/net.js';
import { cfg, findFriend, onEvent, setSetting, upsertFriend } from '../lib/store.js';
import { fmtRate } from '../lib/stats.js';
import { avatar, button, confirmDialog, copyButton, h, icon, mount, stagger, t } from '../lib/ui.js';
import { chatPanel } from './chat.js';
import { codeTiles, seg } from './controls.js';

const NET = {
  online: ['ok', 'share.net.online'],
  connecting: ['warn', 'share.net.connecting'],
  busy: ['warn', 'share.net.busy'],
  error: ['bad', 'share.net.error'],
  offline: ['bad', 'share.net.offline'],
};

export function shareView() {
  const title = h('h1.view-title', t('nav.share'));
  const sub = h('p.view-sub');
  const headActions = h('div.row-trail');
  const body = h('div');
  const root = h('section.view', h('header.view-head', h('div', title, sub), headActions), body);
  let mode = '';

  // --- dauerhafte Bausteine ------------------------------------------------
  const tiles = codeTiles(cfg.code, true);
  const netLine = h('div.net-line');
  const shareBtn = button('.btn.primary.xl.block', { icon: 'ScreenShare', label: t('share.start'), onclick: () => start(shareBtn) });
  const preview = h('video', { autoplay: true, muted: true, playsInline: true });
  const previewWrap = h('div.preview-wrap');
  const chips = h('div.chips');
  const stageBar = h('div.stage-bar');
  const warn = h('div.warn-line', icon('TriangleAlert', 15), t('share.windowWarn'));
  const people = h('div.list');
  const peopleCount = h('span.faint.num');
  const chat = chatPanel({
    messages: () => host.chat,
    send: (text) => host.sendChat(text),
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
      h('div.row-main', h('span.row-title', t('policy.join')), h('span.row-sub', t('policy.join.hint'))),
      (segs.joinPolicy = seg([['ask', t('policy.ask')], ['friends', t('policy.friends')], ['auto', t('policy.all')]], cfg.settings.joinPolicy, (v) => setSetting('joinPolicy', v)))),
    h('div.row',
      h('div.row-main', h('span.row-title', t('policy.control')), h('span.row-sub', t('policy.control.hint'))),
      (segs.controlPolicy = seg([['ask', t('policy.ask')], ['auto', t('policy.allow')], ['deny', t('policy.off')]], cfg.settings.controlPolicy, (v) => setSetting('controlPolicy', v)))));

  // --- Layout je nach Zustand -------------------------------------------------
  function layout() {
    const next = host.sharing || host.viewers.size || host.pending.size ? 'live' : 'idle';
    if (next === mode) return;
    mode = next;
    if (mode === 'idle') {
      mount(headActions);
      mount(body, stagger(h('div.share-idle',
        h('div.card.code-card',
          h('span.eyebrow', t('share.yourCode')),
          tiles,
          h('div.code-actions',
            copyButton(() => fmtCode(cfg.code), '.btn.sm', null, t('common.copy')),
            h('button.btn.sm.ghost', { type: 'button', onclick: regenerate }, icon('RefreshCw', 15), t('share.newCode'))),
          netLine),
        shareBtn,
        h('div.group', h('div.group-title', t('share.access')), policies()),
        h('p.faint', { style: { textAlign: 'center', fontSize: '12.5px' } }, t('share.lanHint')))));
    } else {
      mount(headActions, h('span.badge.num', { style: { height: '28px', padding: '0 10px', fontSize: '13px' } }, h('span.mono', fmtCode(cfg.code))), copyButton(() => fmtCode(cfg.code), '.icon-btn', t('share.copyCode')));
      mount(previewWrap, preview, chips);
      mount(body, h('div.share-live',
        stagger(h('div.col.side-col', h('div.card.stage-card', previewWrap, stageBar, warn), h('div.group', h('div.group-title', t('share.access')), policies()))),
        stagger(h('div.side-col',
          h('div.group', h('div.group-title', t('share.people'), peopleCount), people),
          h('div.group', h('div.group-title', t('chat.title')), h('div.card', chat))))));
    }
  }

  function paintHead() {
    const n = host.viewers.size;
    sub.textContent = mode === 'idle'
      ? t('share.sub.idle')
      : host.sharing ? (host.paused ? t('share.sub.paused') : n ? t('share.sub.watching', { count: n }) : t('share.sub.waiting'))
        : t('share.sub.connected', { count: n });
    const [cls, text] = NET[net.state] || NET.offline;
    mount(netLine, h(`span.dot.${cls}`), t(net.error && net.state !== 'online' ? net.error : text),
      net.state === 'busy' ? h('button.link', { onclick: regenerate }, t('share.takeNewCode')) : null);
  }

  function paintStage() {
    if (mode !== 'live') return;
    if (preview.srcObject !== host.stream) preview.srcObject = host.stream;
    previewWrap.classList.toggle('paused', host.paused);
    if (!host.sharing) {
      mount(previewWrap, h('div.preview-empty', icon('MonitorUp', 30), h('b', t('share.empty.title')), h('p', t('share.empty.text')), shareBtn));
      mount(stageBar, h('span.enc.grow', ''));
      warn.hidden = true;
      return;
    }
    if (!previewWrap.contains(preview)) mount(previewWrap, preview, chips);
    previewWrap.querySelector('.paused-label')?.remove();
    if (host.paused) previewWrap.append(h('div.paused-label', icon('Pause', 18), t('share.paused')));
    warn.hidden = host.shareKind === 'monitor';
    const pause = button('.btn', { icon: host.paused ? 'Play' : 'Pause', label: host.paused ? t('share.resume') : t('share.pause'), onclick: () => host.pause(!host.paused) });
    const swap = button('.btn', { icon: 'Monitor', label: t('share.source'), tip: t('share.source.tip'), onclick: async () => { swap.loading(true); await host.switchSource(); swap.loading(false); } });
    mount(stageBar, swap, pause, h('span.enc.grow'), button('.btn.danger', { icon: 'ScreenShareOff', label: t('share.stop'), onclick: () => host.stopShare() }));
    paintStats();
  }

  function paintStats() {
    if (mode !== 'live' || !host.sharing) return;
    const s = [...host.viewers.values()].find((v) => v.stats)?.stats;
    const n = host.viewers.size;
    mount(chips,
      h('span.chip', h('span.live-dot'), host.paused ? t('share.paused') : t('share.live')),
      h('span.chip.num', icon('Eye', 14), n),
      s?.fps ? h('span.chip.right.num', `${s.fps} FPS · ${fmtRate(s.kbps)}`) : null);
    const enc = stageBar.querySelector('.enc');
    if (enc) enc.textContent = s ? [s.codec, s.encoder, s.limit && t('share.limited', { reason: t(`limit.${s.limit}`) })].filter(Boolean).join(' · ') : '';
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
        h('div.row-main', h('span.row-title', r.name), h('span.row-sub', t('req.watch', { code: fmtCode(r.code) }))),
        h('div.row-trail',
          h('button.btn.sm.ghost', { onclick: () => host.deny(r.id) }, t('req.decline')),
          h('button.btn.sm', { 'data-tip': t('req.always.tip'), onclick: () => { upsertFriend(r.code, r.name, { trusted: true }); host.accept(r); } }, t('req.always')),
          h('button.btn.sm.primary', { onclick: () => host.accept(r) }, t('req.accept'))),
        h('span.timer', { style: { animationDuration: '60s', animationDelay: `-${elapsed}s` } }))));
    }
    for (const v of viewers) {
      const ctl = host.controller === v.id;
      const s = v.stats;
      const canCtl = host.sharing && host.shareKind === 'monitor';
      rows.push(keyed(`v:${v.id}`, h('div.row.hover.has-avatar',
        avatar(v.name, v.color, 32),
        h('div.row-main',
          h('span.row-title', v.name, ctl && h('span.badge.amber', icon('Gamepad2', 12), t('people.controls'))),
          h('span.row-sub.num', [v.rtt != null && `${v.rtt} ms`, s?.fps && `${s.fps} FPS`, s?.route && t(`route.${s.route}`)].filter(Boolean).join(' · ') || fmtCode(v.code))),
        h('div.row-trail',
          h(`button.icon-btn${ctl ? '.on' : ''}`, { 'data-tip': ctl ? t('people.revoke') : t('people.give'), disabled: !canCtl, onclick: () => host.setController(ctl ? null : v.id) }, icon('Gamepad2', 17)),
          h('button.icon-btn', {
            'data-tip': !cfg.settings.shareCursors ? t('people.cursorsOff') : host.cursorHidden(v) ? t('people.showCursor') : t('people.hideCursor'),
            'aria-pressed': String(host.cursorHidden(v)), disabled: !cfg.settings.shareCursors, onclick: () => host.toggleCursor(v),
          }, icon(host.cursorHidden(v) || !cfg.settings.shareCursors ? 'MousePointer2Off' : 'MousePointer2', 17)),
          h(`button.icon-btn${findFriend(v.code) ? '.on' : ''}`, { 'data-tip': findFriend(v.code) ? t('people.saved') : t('people.saveFriend'), onclick: () => { upsertFriend(v.code, v.name); paintPeople(); } }, icon('Star', 17)),
          h('button.icon-btn.danger', { 'data-tip': t('people.remove'), onclick: () => host.kick(v.id) }, icon('X', 17))))));
    }
    if (!rows.length) rows.push(h('div.empty', icon('Users', 24), h('b', t('people.empty.title')), h('span', t('people.empty.text', { code: fmtCode(cfg.code) }))));
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
    const ok = await confirmDialog({ title: t('code.new.title'), text: t('code.new.text'), ok: t('code.new.ok') });
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
  onEvent('settings', ({ key }) => {
    segs[key]?.set(cfg.settings[key]);
    if (key === 'shareCursors') paintPeople();
  });
  paint();
  return root;
}
