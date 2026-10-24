// „Beitreten“: Code-Eingabe, Geräte in der Nähe, Freunde, Verlauf.
import { lan } from '../lib/lan.js';
import { fmtCode, parseCode } from '../lib/net.js';
import { cfg, emit, findFriend, onEvent, removeFriend, upsertFriend } from '../lib/store.js';
import { avatar, button, h, icon, mount, relTime, t, toast } from '../lib/ui.js';
import { viewer } from '../lib/viewer.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const COLORS = ['#3e63dd', '#e5484d', '#30a46c', '#f76b15', '#8e4ec6', '#12a594', '#d6409f', '#0090ff'];
export const colorFor = (code) => COLORS[[...code].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];

export function join(code) {
  const err = viewer.join(code);
  if (err) {
    toast(t(err), { type: 'warn' });
    return false;
  }
  emit('nav', 'session');
  return true;
}

export function joinView() {
  const err = h('p.err');
  const go = button('.btn.primary.lg', { label: t('join.connect'), icon: 'ArrowRight', disabled: true, onclick: () => submit() });
  go.querySelector('.i').classList.add('nudge');
  go.prepend(go.querySelector('.label'));
  const otp = otpInput((code) => {
    go.disabled = code.length < 6;
    err.textContent = '';
    if (code.length === 6) submit();
  });

  function submit() {
    const code = parseCode(otp.value());
    if (!code) {
      err.textContent = t('join.invalid');
      otp.shake();
      return;
    }
    go.loading(true);
    if (!join(code)) go.loading(false);
  }
  onEvent('viewer:state', ({ state }) => {
    if (state !== 'connecting') go.loading(false);
    if (state === 'idle') otp.clear();
  });

  const nearBody = h('div');
  const recentBody = h('div');
  const friendsList = h('div');
  const root = h('section.view',
    h('header.view-head', h('div', h('h1.view-title', t('nav.join')), h('p.view-sub', t('join.sub')))),
    h('div.card.join-hero', otp, go, err),
    h('div.join-grid',
      h('div.col', { style: { display: 'flex', flexDirection: 'column', gap: '28px' } },
        h('div.group', h('div.group-title', t('join.nearby')), nearBody),
        h('div.group', h('div.group-title', t('join.recent')), recentBody)),
      h('div.group', h('div.group-title', t('join.friends')), h('div.list', friendsList, addFriendRow()))));

  const connect = (code) => h('button.btn.sm', { type: 'button', onclick: () => join(code) }, t('join.connect'));

  function paintNear() {
    if (!cfg.settings.lanVisible && !lan.size) {
      return mount(nearBody, h('div.scan', icon('Wifi', 20), t('join.lanOff')));
    }
    if (!lan.size) {
      return mount(nearBody, h('div.scan', h('span.radar'), h('span', h('b', t('join.scanning')), h('br'), t('join.scanning.hint'))));
    }
    mount(nearBody, h('div.near', [...lan.values()].map((p) =>
      h('button.near-card', { type: 'button', onclick: () => join(p.code) },
        avatar(p.name, colorFor(p.code), 34),
        h('div.row-main', h('span.row-title', p.name), h('span.row-sub.mono', fmtCode(p.code))),
        p.sharing && h('span.badge.live', h('span.live-dot'), t('join.sharing'))))));
  }

  function paintFriends() {
    if (!cfg.friends.length) {
      return mount(friendsList, h('div.empty', icon('Star', 24), h('b', t('join.friends.empty')), h('span', t('join.friends.empty.hint'))));
    }
    mount(friendsList, cfg.friends.map((f) => h('div.row.hover.has-avatar',
      avatar(f.name, colorFor(f.code), 32),
      h('div.row-main',
        h('span.row-title', f.name, f.trusted && h('span.badge.green', { 'data-tip': t('friend.trusted.tip') }, icon('ShieldCheck', 12), t('friend.trusted'))),
        h('span.row-sub', h('span.mono', fmtCode(f.code)), lan.get(f.code)?.sharing ? ` · ${t('friend.sharingNow')}` : '')),
      h('div.row-trail',
        h(`button.icon-btn${f.trusted ? '.on' : ''}`, { 'data-tip': f.trusted ? t('friend.untrust') : t('friend.trust'), onclick: () => upsertFriend(f.code, f.name, { trusted: !f.trusted }) }, icon('ShieldCheck', 17)),
        h('button.icon-btn.danger', { 'data-tip': t('common.remove'), onclick: () => removeFriend(f.code) }, icon('Trash2', 17)),
        connect(f.code)))));
  }

  function paintRecent() {
    if (!cfg.history.length) {
      return mount(recentBody, h('div.list', h('div.empty', icon('History', 24), h('b', t('join.recent.empty')), h('span', t('join.recent.empty.hint')))));
    }
    mount(recentBody, h('div.list', cfg.history.slice(0, 6).map((x) => h('div.row.hover.has-avatar',
      avatar(x.name || x.code, colorFor(x.code), 32),
      h('div.row-main', h('span.row-title', x.name || fmtCode(x.code)), h('span.row-sub', `${fmtCode(x.code)} · ${relTime(x.at)}`)),
      h('div.row-trail',
        !findFriend(x.code) && h('button.icon-btn', { 'data-tip': t('people.saveFriend'), onclick: () => upsertFriend(x.code, x.name) }, icon('Star', 17)),
        connect(x.code))))));
  }

  onEvent('lan', () => {
    paintNear();
    paintFriends();
  });
  onEvent('friends', () => {
    paintFriends();
    paintRecent();
  });
  onEvent('history', paintRecent);
  onEvent('settings', ({ key }) => key === 'lanVisible' && paintNear());
  paintNear();
  paintFriends();
  paintRecent();
  root.focusInput = () => otp.focus();
  return root;
}

function addFriendRow() {
  const name = h('input.input', { placeholder: t('friend.name'), maxlength: 32, 'aria-label': t('friend.name.label') });
  const code = h('input.input.mono', { placeholder: t('friend.code'), maxlength: 7, style: { maxWidth: '110px' }, 'aria-label': t('friend.code.label'), onkeydown: (e) => e.key === 'Enter' && add() });
  const add = () => {
    const c = parseCode(code.value);
    if (!c) return toast(t('friend.invalidCode'), { type: 'warn' });
    upsertFriend(c, name.value.trim() || fmtCode(c));
    name.value = code.value = '';
    toast(t('friend.saved'), { type: 'ok', icon: 'Star' });
  };
  return h('div.add-row', name, code, h('button.btn', { type: 'button', onclick: add }, icon('Plus', 16), t('friend.add')));
}

/** Sechs Felder wie bei Bestätigungscodes: tippen, einfügen, löschen, Pfeile. */
function otpInput(onchange) {
  const boxes = Array.from({ length: 6 }, (_, i) =>
    h('input', { maxlength: 1, inputmode: 'text', autocomplete: 'off', spellcheck: false, 'aria-label': t('join.char', { n: i + 1 }) }));
  const el = h('div.otp', boxes.slice(0, 3), h('span.sep'), boxes.slice(3));
  const value = () => boxes.map((b) => b.value).join('');
  const clean = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').split('').filter((c) => ALPHABET.includes(c));
  const fill = (from, chars) => {
    let i = from;
    for (const c of chars) {
      if (i > 5) break;
      boxes[i].value = c;
      pulse(boxes[i]);
      i++;
    }
    boxes[Math.min(i, 5)].focus();
    onchange(value());
  };
  const pulse = (b) => {
    b.classList.remove('filled');
    void b.offsetWidth;
    b.classList.add('filled');
  };
  boxes.forEach((b, i) => {
    b.addEventListener('input', () => {
      const chars = clean(b.value);
      b.value = '';
      if (chars.length) fill(i, chars);
      else onchange(value());
    });
    b.addEventListener('paste', (e) => {
      e.preventDefault();
      fill(0, clean(e.clipboardData.getData('text')));
    });
    b.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !b.value && i > 0) {
        boxes[i - 1].value = '';
        boxes[i - 1].focus();
        onchange(value());
        e.preventDefault();
      }
      if (e.key === 'ArrowLeft' && i > 0) boxes[i - 1].focus();
      if (e.key === 'ArrowRight' && i < 5) boxes[i + 1].focus();
    });
    b.addEventListener('focus', () => b.select());
  });
  el.value = value;
  el.focus = () => boxes[Math.min(value().length, 5)].focus();
  el.clear = () => {
    boxes.forEach((b) => (b.value = ''));
    onchange('');
  };
  el.shake = () => {
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
  };
  return el;
}
