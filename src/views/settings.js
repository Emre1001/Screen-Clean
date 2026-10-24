// Einstellungen als eigene Ansicht mit gleitenden Tabs.
import { call } from '../lib/bridge.js';
import { fmtCode, net } from '../lib/net.js';
import { availableCodecs } from '../lib/quality.js';
import { applyTheme, cfg, DEFAULT_SETTINGS, emit, logs, onEvent, originOf, REPO, save, setProfile, setSetting } from '../lib/store.js';
import { confirmDialog, copyButton, h, icon, mount, t, toast } from '../lib/ui.js';
import { options, seg, setRow, swatches, toggle } from './controls.js';

const TABS = ['general', 'video', 'control', 'network', 'about'];

const set = (key) => (v) => setSetting(key, v);
const tog = (key) => toggle(cfg.settings[key], set(key));
const group = (title, ...rows) => h('div.group', title && h('div.group-title', title), h('div.list', rows));

export function settingsView() {
  let tab = 'general';
  const page = h('div');
  const tabs = seg(TABS.map((v) => [v, t(`settings.tab.${v}`)]), tab, (v) => { tab = v; paint(); }, '.lg');
  const root = h('section.view',
    h('header.view-head', h('div', h('h1.view-title', t('nav.settings')), h('p.view-sub', t('settings.sub')))),
    h('div.settings-tabs', tabs),
    page);

  async function paint() {
    const content = await PAGES[tab]();
    const el = h('div.set-page.stagger', content);
    [...el.children].forEach((c, i) => c.style.setProperty('--i', i));
    mount(page, el);
  }
  root.open = (next) => {
    tab = next;
    tabs.set(next);
    paint();
  };
  onEvent('log', () => tab === 'about' && paintLog());
  paint();
  return root;
}

const logList = h('div.log-list');
function paintLog() {
  mount(logList, logs.slice(-200).reverse().map((l) =>
    h(`div.log-line.${l.level}`, h('time', window.I18n.date(new Date(l.ts), { timeStyle: 'medium' })), h('span', l.msg))));
}

/** „Sprache“-Zeile: zeigt die aktuelle Sprache, öffnet das Auswahlfenster. */
function languageRow() {
  const trigger = h('button.lang-trigger', { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-label': t('settings.language') },
    h('span', { 'data-lang-current': true }), icon('ChevronDown', 16, 'lang-chevron'));
  requestAnimationFrame(() => window.initLanguagePicker(trigger));
  return setRow(t('settings.language'), t('settings.language.hint'), trigger);
}

const PAGES = {
  async general() {
    const name = h('input.input', {
      value: cfg.profile.name, maxlength: 32, style: { width: '220px' }, 'aria-label': t('profile.name'),
      onchange: (e) => setProfile({ name: e.target.value.trim() || cfg.profile.name }),
    });
    const auto = await call('autostart_get').catch(() => false);
    return [
      group(t('profile.title'),
        setRow(t('profile.name'), t('profile.name.hint'), name),
        setRow(t('profile.color'), null, swatches(cfg.profile.color, (c) => setProfile({ color: c })))),
      group(t('settings.appearance'),
        setRow(t('settings.theme'), t('settings.theme.hint'),
          seg([['system', t('theme.system'), 'SunMoon'], ['light', t('theme.light'), 'Sun'], ['dark', t('theme.dark'), 'Moon']], cfg.settings.theme,
            (v) => { setSetting('theme', v); applyTheme(originOf(document.activeElement)); })),
        languageRow(),
        setRow(t('settings.cursors'), t('settings.cursors.hint'), tog('remoteCursors')),
        setRow(t('settings.sounds'), t('settings.sounds.hint'), tog('sounds')),
        setRow(t('settings.diagnostics'), t('settings.diagnostics.hint'), tog('diagnostics'))),
      group(t('settings.system'),
        setRow(t('settings.tray'), t('settings.tray.hint'), toggle(cfg.settings.closeToTray, (v) => { setSetting('closeToTray', v); call('set_close_to_tray', { enabled: v }); })),
        setRow(t('settings.autostart'), t('settings.autostart.hint'), toggle(auto, async (v) => {
          const res = await call('autostart_set', { enabled: v }).catch((e) => toast(t('settings.autostart.failed', { error: String(e) }), { type: 'error' }));
          setSetting('autostart', !!res);
        })),
        setRow(t('settings.setup'), t('settings.setup.hint'), h('button.btn', { onclick: () => emit('setup') }, t('common.open')))),
    ];
  },

  video() {
    const codecs = availableCodecs();
    const m = cfg.settings.manual;
    const range = (key, min, max, step, unit) => {
      const out = h('span.range-val', `${m[key]} ${unit}`);
      return h('div.range',
        h('input', { type: 'range', min, max, step, value: m[key], 'aria-label': unit, oninput: (e) => { out.textContent = `${e.target.value} ${unit}`; }, onchange: (e) => { m[key] = Number(e.target.value); setSetting('manual', m); } }),
        out);
    };
    const manual = h('div.group', { hidden: cfg.settings.quality !== 'manual' }, h('div.list',
      setRow(t('video.fps'), null, range('fps', 15, 144, 1, 'FPS')),
      setRow(t('video.resolution'), t('video.resolution.hint'), seg([[0, t('video.original')], [1440, '1440p'], [1080, '1080p'], [720, '720p']], m.height, (v) => { m.height = v; setSetting('manual', m); })),
      setRow(t('video.bitrate'), t('video.bitrate.hint'), range('bitrate', 1, 50, 1, 'Mbit/s'))));
    return [
      h('div.group', h('div.group-title', t('video.quality')), options([
        { value: 'auto', title: t('quality.auto'), desc: t('quality.auto.desc'), icon: 'Sparkles', tag: t('common.recommended') },
        { value: 'gaming', title: t('quality.gaming'), desc: t('quality.gaming.desc'), icon: 'Gamepad2' },
        { value: 'text', title: t('quality.text'), desc: t('quality.text.desc'), icon: 'FileText' },
        { value: 'saver', title: t('quality.saver'), desc: t('quality.saver.desc'), icon: 'Laptop' },
        { value: 'manual', title: t('quality.manual'), desc: t('quality.manual.desc'), icon: 'SlidersHorizontal' },
      ], cfg.settings.quality, (v) => { setSetting('quality', v); manual.hidden = v !== 'manual'; })),
      manual,
      group(t('video.tech'),
        setRow('Codec', t('video.codec.hint', { list: codecs.map((c) => (c === 'H264' ? 'H.264' : c)).join(', ') || '–' }),
          seg([['auto', 'Auto'], ...codecs.map((c) => [c, c === 'H264' ? 'H.264' : c])], cfg.settings.codec, set('codec'))),
        setRow(t('video.audio'), t('video.audio.hint'), tog('audio'))),
    ];
  },

  async control() {
    const mons = await call('list_monitors').catch(() => []);
    return [
      group(t('control.joining'),
        setRow(t('control.join'), t('control.join.hint'), seg([['ask', t('policy.ask')], ['friends', t('policy.friends')], ['auto', t('policy.all')]], cfg.settings.joinPolicy, set('joinPolicy'))),
        setRow(t('policy.control'), t('control.control.hint'), seg([['ask', t('policy.ask')], ['auto', t('policy.allow')], ['deny', t('policy.off')]], cfg.settings.controlPolicy, set('controlPolicy'))),
        setRow(t('control.shareCursors'), t('control.shareCursors.hint'), tog('shareCursors')),
        setRow(t('control.cursorNames'), t('control.cursorNames.hint'), seg([['full', t('cursorNames.full')], ['initial', t('cursorNames.initial')], ['off', t('cursorNames.off')]], cfg.settings.cursorNames, set('cursorNames')))),
      group(t('control.watching'),
        setRow(t('control.autoRequest'), t('control.autoRequest.hint'), tog('autoRequestControl'))),
      group(t('control.monitors'),
        setRow(t('control.monitor'), t('control.monitor.hint'),
          seg([['auto', 'Auto'], ...mons.map((mo, i) => [String(i), `${i + 1} · ${mo.rect.w}×${mo.rect.h}`])], String(cfg.settings.monitor), set('monitor')))),
      h('div.note', icon('ShieldCheck', 17), t('control.brake'), h('kbd', t('kbd.ctrl')), h('kbd', 'Shift'), h('kbd', 'X'), t('control.brake.text')),
    ];
  },

  network() {
    const sig = h('input.input', { value: cfg.settings.signaling, placeholder: 'https://peer.example.com/', style: { width: '240px' }, 'aria-label': t('network.signaling') });
    return [
      group(t('network.connection'),
        setRow(t('network.code'), t('network.code.hint'), h('div.row-trail', h('span.mono', { style: { fontSize: '15px', fontWeight: 600 } }, fmtCode(cfg.code)), copyButton(() => fmtCode(cfg.code)))),
        setRow(t('network.reconnect'), t('network.reconnect.hint'), tog('reconnect')),
        setRow(t('network.lan'), t('network.lan.hint'), tog('lanVisible'))),
      group(t('network.advanced'),
        setRow(t('network.signaling'), t('network.signaling.hint'),
          h('div.row-trail', sig, h('button.btn', { onclick: () => { setSetting('signaling', sig.value.trim()); net.start(); toast(t('network.signaling.saved'), { type: 'ok' }); } }, t('common.apply')))),
        setRow(t('network.compat'), t('network.compat.hint'), toggle(cfg.settings.compat, async (v) => {
          setSetting('compat', v);
          if (await confirmDialog({ title: t('network.restart.title'), text: t('network.restart.text'), ok: t('network.restart.ok') })) {
            save();
            setTimeout(() => call('restart'), 300);
          }
        }))),
      group(t('data.title'),
        setRow(t('data.history'), null, h('button.btn', { onclick: () => { cfg.history = []; save(); emit('history'); toast(t('data.history.done'), { type: 'ok' }); } }, t('common.delete'))),
        setRow(t('data.friends'), null, h('button.btn.danger', { onclick: async () => {
          if (await confirmDialog({ title: t('data.friends.title'), text: t('data.friends.text'), ok: t('common.remove'), danger: true })) {
            cfg.friends = [];
            save();
            emit('friends');
          }
        } }, t('common.remove'))),
        setRow(t('data.reset'), t('data.reset.hint'), h('button.btn', { onclick: async () => {
          if (await confirmDialog({ title: t('data.reset.title'), ok: t('common.reset') })) {
            cfg.settings = { ...DEFAULT_SETTINGS };
            save();
            applyTheme();
            Object.keys(DEFAULT_SETTINGS).forEach((key) => emit('settings', { key }));
            toast(t('data.reset.done'), { type: 'ok' });
          }
        } }, t('common.reset')))),
    ];
  },

  async about() {
    const info = await call('sys_info').catch(() => ({}));
    paintLog();
    const updates = h('div.group',
      h('div.group-title', t('settings.updates')),
      h('div.list',
        h('div.row.set-row',
          h('div.set-text', h('div.set-title', { 'data-update-version': true }), h('div.set-desc', { 'data-update-status': true, role: 'status' })),
          h('button.btn', { type: 'button', 'data-update-check': true }, t('update.check'))),
        setRow(t('update.auto'), t('update.auto.hint'), toggle(localStorage.getItem('update.auto') !== '0', (v) => localStorage.setItem('update.auto', v ? '1' : '0')))));
    requestAnimationFrame(() => window.UpdateUI?.bindSettings(updates));
    return [
      h('div.card.about',
        h('img', { src: '/logo.svg', alt: '', width: 56, height: 56 }),
        h('div', h('h3', 'Screen-Clean'), h('p.muted', [`${t('about.version', { version: info.version || '0.1.0' })}`, info.os, info.arch, info.session].filter(Boolean).join(' · '))),
        h('div.row-trail', { style: { marginInlineStart: 'auto' } }, h('button.btn', { onclick: () => call('open_url', { url: REPO }) }, icon('Globe', 16), 'GitHub'))),
      updates,
      group(t('about.shortcuts'),
        setRow(t('about.toggleApp'), null, h('div.row-trail', h('kbd', 'Alt'), h('kbd', 'Shift'), h('kbd', 'S'))),
        setRow(t('about.brake'), null, h('div.row-trail', h('kbd', t('kbd.ctrl')), h('kbd', 'Shift'), h('kbd', 'X')))),
      h('div.group',
        h('div.group-title', t('about.log'), h('div.row-trail',
          copyButton(() => logs.map((l) => `${new Date(l.ts).toISOString()} [${l.level}] ${l.msg}`).join('\n'), '.btn.sm.ghost', null, t('common.copy')),
          h('button.btn.sm.ghost', { onclick: () => call('log_open').catch((e) => toast(String(e), { type: 'warn' })) }, icon('FileText', 15), t('about.openLog')))),
        h('div.card', logList)),
    ];
  },
};
