// Einrichtung beim ersten Start (und jederzeit aus den Einstellungen).
import { call } from '../lib/bridge.js';
import { fmtCode, net } from '../lib/net.js';
import { availableCodecs } from '../lib/quality.js';
import { cfg, onEvent, save, setProfile, setSetting } from '../lib/store.js';
import { button, copyButton, h, icon, mount } from '../lib/ui.js';
import { codeTiles, cursorEl, options, seg, swatches, toggle } from './controls.js';

export function openSetup({ onDone } = {}) {
  let step = 0;
  const body = h('div.setup-body');
  const bar = h('i');
  const counter = h('span.step-count');
  const back = button('.btn.ghost', { icon: 'ArrowLeft', label: 'Zurück', onclick: () => go(step - 1) });
  const next = button('.btn.primary.lg', { label: 'Weiter', icon: 'ArrowRight' });
  next.prepend(next.querySelector('.label'));
  next.querySelector('.i').classList.add('nudge');
  const root = h('div.setup', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Einrichtung' },
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
    next.querySelector('.label').textContent = s.cta || 'Weiter';
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
      cta: 'Los geht’s',
      content: [
        h('img.hero-logo', { src: '/logo.svg', alt: '' }),
        h('h1.title', 'Willkommen bei Screen-Clean'),
        h('p.lead', 'Bildschirm teilen und gemeinsam steuern – direkt von Gerät zu Gerät. Ohne Konto, ohne Cloud. Die Einrichtung dauert eine Minute.'),
        h('div.features',
          [['Zap', 'Direkt verbunden', 'Peer-to-Peer, bis 120 FPS'], ['MousePointer2', 'Live-Cursor', 'Jeder in seiner Farbe'], ['Gamepad2', 'Fernsteuerung', 'Nur wenn du es erlaubst']].map(([ic, t, d]) =>
            h('div.feature', icon(ic, 20), h('b', t), h('span', d)))),
      ],
    };
  }

  function profile() {
    const demo = h('div.cursor-demo', h('span.demo-hint', 'Beweg die Maus hierher'));
    let cur = cursorEl(cfg.profile.name || 'Du', cfg.profile.color);
    demo.append(cur);
    const refresh = () => {
      const n = cursorEl(cfg.profile.name || 'Du', cfg.profile.color);
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
      value: cfg.profile.name, maxlength: 32, placeholder: 'Dein Name', 'aria-label': 'Dein Name',
      oninput: (e) => { setProfile({ name: e.target.value.trim() }); refresh(); },
      onkeydown: (e) => e.key === 'Enter' && go(step + 1),
    });
    return {
      content: [
        h('h1.title', 'Wie sollen dich andere sehen?'),
        h('p.lead', 'Name und Farbe stehen an deinem Cursor, wenn du bei jemandem zuschaust.'),
        h('div.profile-grid',
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } },
            h('label.field', h('span.field-label', 'Name'), name),
            h('div.field', h('span.field-label', 'Farbe'), swatches(cfg.profile.color, (c) => { setProfile({ color: c }); refresh(); }))),
          demo),
      ],
      next: () => {
        if (!cfg.profile.name) setProfile({ name: 'Ich' });
        go(step + 1);
      },
    };
  }

  function sharing() {
    return {
      content: [
        h('h1.title', 'Wenn du deinen Bildschirm teilst'),
        h('p.lead', 'Lässt sich jederzeit beim Teilen umstellen.'),
        h('div.list',
          h('div.row.set-row', h('div.set-text', h('div.set-title', 'Wer darf zuschauen?'), h('div.set-desc', 'Vertraute Freunde kommen immer direkt rein.')),
            seg([['ask', 'Fragen'], ['friends', 'Freunde'], ['auto', 'Alle']], cfg.settings.joinPolicy, (v) => setSetting('joinPolicy', v))),
          h('div.row.set-row', h('div.set-text', h('div.set-title', 'Wer darf steuern?'), h('div.set-desc', 'Du kannst die Steuerung jederzeit zurücknehmen.')),
            seg([['ask', 'Fragen'], ['auto', 'Erlauben'], ['deny', 'Niemand']], cfg.settings.controlPolicy, (v) => setSetting('controlPolicy', v)))),
        h('div.toggles',
          toggle(cfg.settings.audio, (v) => setSetting('audio', v), 'Systemton mitsenden'),
          toggle(cfg.settings.lanVisible, (v) => setSetting('lanVisible', v), 'Für Geräte im selben WLAN sichtbar sein')),
      ],
    };
  }

  function quality() {
    const slot = h('div');
    const paint = (rec) => mount(slot, options([
      { value: 'auto', title: 'Automatisch', desc: 'Passt sich der Leitung an', icon: 'Sparkles', tag: rec === 'auto' ? 'Empfohlen' : '' },
      { value: 'gaming', title: 'Flüssig', desc: 'Bis 120 FPS für Spiele', icon: 'Gamepad2' },
      { value: 'text', title: 'Scharf', desc: 'Volle Auflösung für Text', icon: 'FileText' },
      { value: 'saver', title: 'Sparsam', desc: 'Schont Akku und Leitung', icon: 'Laptop', tag: rec === 'saver' ? 'Empfohlen' : '' },
    ], cfg.settings.quality, (v) => setSetting('quality', v)));
    paint('auto');
    navigator.getBattery?.().then((b) => b && !(b.charging && b.level === 1) && paint('saver')).catch(() => {});
    return {
      content: [
        h('h1.title', 'Wie soll es aussehen?'),
        h('p.lead', 'Später unter Einstellungen → Video auch mit eigenen Werten.'),
        slot,
      ],
    };
  }

  function systemCheck() {
    if (!checks) {
      checks = h('div.list.checks');
      runChecks(checks);
    }
    return { content: [h('h1.title', 'Kurzer System-Check'), h('p.lead', 'Wir schauen, ob alles bereit ist. Du kannst jederzeit weiter.'), checks] };
  }

  function done() {
    const tiles = codeTiles(cfg.code, true);
    setTimeout(() => tiles.set(cfg.code), 150);
    const off = onEvent('code', () => tiles.set(cfg.code));
    return {
      cta: 'Fertig',
      next: () => {
        off();
        finish();
      },
      content: [
        h('div.done-mark', checkSvg()),
        h('h1.title', `Alles bereit, ${cfg.profile.name || 'du'}.`),
        h('p.lead', 'Das ist dein persönlicher Code. Er bleibt gleich – Freunde können ihn speichern.'),
        h('div.done-code', tiles, copyButton(() => fmtCode(cfg.code), '.btn', null, 'Kopieren')),
        h('div.toggles',
          toggle(cfg.settings.closeToTray, (v) => { setSetting('closeToTray', v); call('set_close_to_tray', { enabled: v }); }, 'Beim Schließen im Hintergrund weiterlaufen'),
          toggle(cfg.settings.autostart, async (v) => setSetting('autostart', !!(await call('autostart_set', { enabled: v }).catch(() => false))), 'Beim Anmelden starten')),
      ],
    };
  }

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
    const hint = h('span.row-sub', 'prüfe …');
    const el = h('div.row.enter', h('span.check-icon', icon(ic, 17)), h('div.row-main', h('span.row-title', title), hint), status);
    list.append(el);
    return (state, text) => {
      el.className = `row ${state}`;
      hint.textContent = text;
      mount(status, icon(state === 'ok' ? 'CircleCheck' : 'TriangleAlert', 19));
    };
  };

  const rtc = row('Zap', 'Direktverbindung (WebRTC)');
  await wait(300);
  if (typeof RTCPeerConnection === 'function') rtc('ok', 'Verfügbar');
  else rtc('fail', 'Dieses WebView kann kein WebRTC.');

  const cap = row('MonitorUp', 'Bildschirm aufnehmen');
  await wait(220);
  if (navigator.mediaDevices?.getDisplayMedia) cap('ok', 'Bereit');
  else cap('warn', 'Teilen nicht möglich – Zuschauen geht trotzdem.');

  const codec = row('Cpu', 'Video-Codecs');
  await wait(220);
  const cs = availableCodecs();
  codec(cs.length ? 'ok' : 'warn', cs.length ? cs.map((c) => (c === 'H264' ? 'H.264' : c)).join(' · ') : 'Keine Angaben vom WebView');

  const sig = row('Globe', 'Erreichbarkeit');
  for (let i = 0; i < 40 && net.state !== 'online'; i++) await wait(250);
  if (net.state === 'online') sig('ok', `Online als ${fmtCode(cfg.code)}`);
  else sig('warn', net.error || 'Server noch nicht erreichbar – Internet oder Firewall prüfen.');

  const inp = row('MousePointer2', 'Fernsteuerung');
  try {
    const r = await call('input_check');
    if (r === 'wayland') inp('warn', 'Wayland: erreicht nur XWayland-Apps. Für volle Kontrolle X11 nutzen.');
    else if (r === 'browser') inp('warn', 'Nur in der Desktop-App verfügbar.');
    else inp('ok', 'Maus und Tastatur können gesteuert werden');
  } catch (e) {
    inp('fail', `Nicht verfügbar: ${e}`);
  }

  const lanRow = row('Wifi', 'WLAN-Erkennung');
  try {
    lanRow('ok', `Aktiv auf UDP-Port ${await call('discovery_status')}`);
  } catch (e) {
    lanRow('warn', String(e));
  }
}
