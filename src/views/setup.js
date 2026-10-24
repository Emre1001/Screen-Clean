// Einrichtung beim ersten Start (und jederzeit aus den Einstellungen).
import { call } from '../lib/bridge.js';
import { fmtCode, net } from '../lib/net.js';
import { availableCodecs } from '../lib/quality.js';
import { cfg, onEvent, save, setProfile, setSetting } from '../lib/store.js';
import { button, copyButton, h, icon, mount, t } from '../lib/ui.js';
import { codeTiles, cursorEl, options, seg, swatches, toggle } from './controls.js';

export function openSetup({ onDone } = {}) {
  let step = 0;
  const body = h('div.setup-body');
  const bar = h('i');
  const counter = h('span.step-count');
  const back = button('.btn.ghost', { icon: 'ArrowLeft', label: t('common.back'), onclick: () => go(step - 1) });
  const next = button('.btn.primary.lg', { label: t('common.next'), icon: 'ArrowRight' });
  next.prepend(next.querySelector('.label'));
  next.querySelector('.i').classList.add('nudge');
  const root = h('div.setup', { role: 'dialog', 'aria-modal': 'true', 'aria-label': t('settings.setup') },
    h('div.setup-card', h('div.progress', bar), body, h('div.setup-foot', back, counter, next)));
  document.body.append(root);

  let checks = null; // System-Check läuft nur einmal, bleibt beim Hin und Her erhalten
  const STEPS = [welcome, profile, sharing, quality, systemCheck, done];

  function go(n) {
    const dir = n >= step ? 'fwd' : 'back';
    step = Math.max(0, Math.min(STEPS.length - 1, n));
    const s = STEPS[step]();
    body.className = `setup-body ${dir}`;
    mount(body, s.content);
    [...body.children].forEach((c, i) => c.style.setProperty('--i', i));
    bar.style.width = `${((step + 1) / STEPS.length) * 100}%`;
    counter.textContent = `${step + 1} / ${STEPS.length}`;
    back.style.visibility = step > 0 && step < STEPS.length - 1 ? 'visible' : 'hidden';
    next.querySelector('.label').textContent = s.cta || t('common.next');
    back.querySelector('.label').textContent = t('common.back');
    next.onclick = () => (s.next ? s.next() : go(step + 1));
    body.querySelector('input:not([type=checkbox])')?.focus();
  }

  function finish() {
    cfg.setupDone = true;
    save();
    root.classList.add('out');
    setTimeout(() => root.remove(), 420);
    onDone?.();
  }

  // --- Schritte ------------------------------------------------------------
  function welcome() {
    return {
      cta: t('setup.start'),
      content: [
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' } }, h('img.hero-logo', { src: '/logo.svg', alt: '' }), languageCorner()),
        h('h1.title', t('setup.welcome')),
        h('p.lead', t('setup.welcome.lead')),
        h('div.features',
          [['Zap', 'setup.f1'], ['MousePointer2', 'setup.f2'], ['Gamepad2', 'setup.f3']].map(([ic, k]) =>
            h('div.feature', icon(ic, 20), h('b', t(k)), h('span', t(`${k}.text`))))),
      ],
    };
  }

  function profile() {
    const demo = h('div.cursor-demo', h('span.demo-hint', t('setup.demoHint')));
    let cur = cursorEl(cfg.profile.name || t('people.you'), cfg.profile.color);
    demo.append(cur);
    const refresh = () => {
      const n = cursorEl(cfg.profile.name || t('people.you'), cfg.profile.color);
      n.style.left = cur.style.left;
      n.style.top = cur.style.top;
      n.style.animation = 'none';
      cur.replaceWith(n);
      cur = n;
    };
    demo.addEventListener('pointermove', (e) => {
      const r = demo.getBoundingClientRect();
      cur.style.left = `${e.clientX - r.left}px`;
      cur.style.top = `${e.clientY - r.top}px`;
    });
    const name = h('input.input.lg', {
      value: cfg.profile.name, maxlength: 32, placeholder: t('setup.yourName'), 'aria-label': t('setup.yourName'),
      oninput: (e) => { setProfile({ name: e.target.value.trim() }); refresh(); },
      onkeydown: (e) => e.key === 'Enter' && go(step + 1),
    });
    return {
      content: [
        h('h1.title', t('setup.profile.title')),
        h('p.lead', t('setup.profile.lead')),
        h('div.profile-grid',
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } },
            h('label.field', h('span.field-label', t('profile.name')), name),
            h('div.field', h('span.field-label', t('setup.color')), swatches(cfg.profile.color, (c) => { setProfile({ color: c }); refresh(); }))),
          demo),
      ],
      next: () => {
        if (!cfg.profile.name) setProfile({ name: t('setup.defaultName') });
        go(step + 1);
      },
    };
  }

  function sharing() {
    return {
      content: [
        h('h1.title', t('setup.share.title')),
        h('p.lead', t('setup.share.lead')),
        h('div.list',
          h('div.row.set-row', h('div.set-text', h('div.set-title', t('setup.whoWatch')), h('div.set-desc', t('policy.join.hint'))),
            seg([['ask', t('policy.ask')], ['friends', t('policy.friends')], ['auto', t('policy.all')]], cfg.settings.joinPolicy, (v) => setSetting('joinPolicy', v))),
          h('div.row.set-row', h('div.set-text', h('div.set-title', t('setup.whoControl')), h('div.set-desc', t('setup.whoControl.hint'))),
            seg([['ask', t('policy.ask')], ['auto', t('policy.allow')], ['deny', t('policy.nobody')]], cfg.settings.controlPolicy, (v) => setSetting('controlPolicy', v)))),
        h('div.toggles',
          toggle(cfg.settings.audio, (v) => setSetting('audio', v), t('setup.audio')),
          toggle(cfg.settings.lanVisible, (v) => setSetting('lanVisible', v), t('setup.lan'))),
      ],
    };
  }

  function quality() {
    const slot = h('div');
    const paint = (rec) => mount(slot, options([
      { value: 'auto', title: t('quality.auto'), desc: t('quality.auto.desc'), icon: 'Sparkles', tag: rec === 'auto' ? t('common.recommended') : '' },
      { value: 'gaming', title: t('quality.gaming'), desc: t('quality.gaming.desc'), icon: 'Gamepad2' },
      { value: 'text', title: t('quality.text'), desc: t('quality.text.desc'), icon: 'FileText' },
      { value: 'saver', title: t('quality.saver'), desc: t('quality.saver.desc'), icon: 'Laptop', tag: rec === 'saver' ? t('common.recommended') : '' },
    ], cfg.settings.quality, (v) => setSetting('quality', v)));
    paint('auto');
    navigator.getBattery?.().then((b) => b && !(b.charging && b.level === 1) && paint('saver')).catch(() => {});
    return {
      content: [
        h('h1.title', t('setup.quality.title')),
        h('p.lead', t('setup.quality.lead')),
        slot,
      ],
    };
  }

  function systemCheck() {
    if (!checks) {
      checks = h('div.list.checks');
      runChecks(checks);
    }
    return { content: [h('h1.title', t('setup.check.title')), h('p.lead', t('setup.check.lead')), checks] };
  }

  function done() {
    const tiles = codeTiles(cfg.code, true);
    setTimeout(() => tiles.set(cfg.code), 150);
    const off = onEvent('code', () => tiles.set(cfg.code));
    return {
      cta: t('setup.finish'),
      next: () => {
        off();
        finish();
      },
      content: [
        h('div.done-mark', checkSvg()),
        h('h1.title', t('setup.done.title', { name: cfg.profile.name || t('people.you') })),
        h('p.lead', t('setup.done.lead')),
        h('div.done-code', tiles, copyButton(() => fmtCode(cfg.code), '.btn', null, t('common.copy'))),
        h('div.toggles',
          toggle(cfg.settings.closeToTray, (v) => { setSetting('closeToTray', v); call('set_close_to_tray', { enabled: v }); }, t('setup.tray')),
          toggle(cfg.settings.autostart, async (v) => setSetting('autostart', !!(await call('autostart_set', { enabled: v }).catch(() => false))), t('settings.autostart'))),
      ],
    };
  }

  // Sprache schon in der Einrichtung wählbar – Schritt neu zeichnen, wenn sie wechselt
  function languageCorner() {
    const trigger = h('button.lang-trigger', { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-label': t('settings.language') },
      icon('Globe', 15), h('span', { 'data-lang-current': true }), icon('ChevronDown', 16, 'lang-chevron'));
    requestAnimationFrame(() => window.initLanguagePicker(trigger));
    return trigger;
  }
  const off = window.I18n.onChange(() => (root.isConnected ? go(step) : off()));

  go(0);
}

function checkSvg() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '30');
  svg.setAttribute('height', '30');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', 'M5 12.5l4.5 4.5L19 7.5');
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '2.4');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  svg.append(p);
  return svg;
}

async function runChecks(list) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const row = (ic, title) => {
    const status = h('span.check-status', h('span.spinner'));
    const hint = h('span.row-sub', t('check.running'));
    const el = h('div.row.enter', h('span.check-icon', icon(ic, 17)), h('div.row-main', h('span.row-title', title), hint), status);
    list.append(el);
    return (state, text) => {
      el.className = `row ${state}`;
      hint.textContent = text;
      mount(status, icon(state === 'ok' ? 'CircleCheck' : 'TriangleAlert', 19));
    };
  };

  const rtc = row('Zap', t('check.webrtc'));
  await wait(300);
  if (typeof RTCPeerConnection === 'function') rtc('ok', t('check.available'));
  else rtc('fail', t('check.webrtc.fail'));

  const cap = row('MonitorUp', t('check.capture'));
  await wait(220);
  if (navigator.mediaDevices?.getDisplayMedia) cap('ok', t('check.ready'));
  else cap('warn', t('check.capture.fail'));

  const codec = row('Cpu', t('check.codecs'));
  await wait(220);
  const cs = availableCodecs();
  codec(cs.length ? 'ok' : 'warn', cs.length ? cs.map((c) => (c === 'H264' ? 'H.264' : c)).join(' · ') : t('check.codecs.none'));

  const sig = row('Globe', t('check.reach'));
  for (let i = 0; i < 40 && net.state !== 'online'; i++) await wait(250);
  if (net.state === 'online') sig('ok', t('check.online', { code: fmtCode(cfg.code) }));
  else sig('warn', t(net.error || 'check.offline'));

  const inp = row('MousePointer2', t('policy.control'));
  try {
    const r = await call('input_check');
    if (r === 'wayland') inp('warn', t('check.input.wayland'));
    else if (r === 'browser') inp('warn', t('check.input.browser'));
    else inp('ok', t('check.input.ok'));
  } catch (e) {
    inp('fail', t('check.input.fail', { error: String(e) }));
  }

  const lanRow = row('Wifi', t('check.lan'));
  try {
    lanRow('ok', t('check.lan.ok', { port: await call('discovery_status') }));
  } catch (e) {
    lanRow('warn', String(e));
  }
}
