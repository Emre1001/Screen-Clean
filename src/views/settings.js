// Einstellungen als eigene Ansicht mit gleitenden Tabs.
import { call } from '../lib/bridge.js';
import { fmtCode, net } from '../lib/net.js';
import { availableCodecs } from '../lib/quality.js';
import { applyTheme, cfg, DEFAULT_SETTINGS, emit, logs, onEvent, REPO, save, setProfile, setSetting } from '../lib/store.js';
import { confirmDialog, copyButton, h, icon, mount, toast } from '../lib/ui.js';
import { options, seg, setRow, swatches, toggle } from './controls.js';

const TABS = [
  ['general', 'Allgemein'],
  ['video', 'Video'],
  ['control', 'Steuerung'],
  ['network', 'Netzwerk'],
  ['about', 'Info'],
];

const set = (key) => (v) => setSetting(key, v);
const tog = (key) => toggle(cfg.settings[key], set(key));
const group = (title, ...rows) => h('div.group', title && h('div.group-title', title), h('div.list', rows));

export function settingsView() {
  let tab = 'general';
  const page = h('div');
  const tabs = seg(TABS.map(([v, l]) => [v, l]), tab, (v) => { tab = v; paint(); }, '.lg');
  const root = h('section.view',
    h('header.view-head', h('div', h('h1.view-title', 'Einstellungen'), h('p.view-sub', 'Alles wird sofort gespeichert.'))),
    h('div.settings-tabs', tabs),
    page);

  async function paint() {
    const content = await PAGES[tab]();
    const el = h('div.set-page.stagger', content);
    [...el.children].forEach((c, i) => c.style.setProperty('--i', i));
    mount(page, el);
  }
  root.open = (t) => {
    tab = t;
    tabs.set(t);
    paint();
  };
  onEvent('log', () => tab === 'about' && paintLog());
  paint();
  return root;
}

const logList = h('div.log-list');
function paintLog() {
  mount(logList, logs.slice(-200).reverse().map((l) => h(`div.log-line.${l.level}`, h('time', new Date(l.ts).toLocaleTimeString('de-DE')), h('span', l.msg))));
}

const PAGES = {
  async general() {
    const name = h('input.input', {
      value: cfg.profile.name, maxlength: 32, style: { width: '220px' }, 'aria-label': 'Anzeigename',
      onchange: (e) => setProfile({ name: e.target.value.trim() || cfg.profile.name }),
    });
    const auto = await call('autostart_get').catch(() => false);
    return [
      group('Profil',
        setRow('Name', 'Steht an deinem Cursor, wenn du bei anderen zuschaust.', name),
        setRow('Cursor-Farbe', null, swatches(cfg.profile.color, (c) => setProfile({ color: c })))),
      group('Darstellung',
        setRow('Erscheinungsbild', 'Folgt standardmäßig deinem System.', seg([['system', 'System', 'SunMoon'], ['light', 'Hell', 'Sun'], ['dark', 'Dunkel', 'Moon']], cfg.settings.theme, (v) => { setSetting('theme', v); applyTheme(); })),
        setRow('Cursor der anderen', 'Farbige Cursor live über dem Bild – beim Teilen als Overlay auf deinem Desktop.', tog('remoteCursors')),
        setRow('Töne', 'Leise Hinweise bei Anfragen, Chat und Steuerung.', tog('sounds')),
        setRow('Verbindungsdaten', 'FPS, Bitrate und Ping beim Zuschauen immer einblenden.', tog('diagnostics'))),
      group('System',
        setRow('Im Hintergrund weiterlaufen', 'Beim Schließen bleibt Screen-Clean im Tray, damit dich Freunde erreichen.', toggle(cfg.settings.closeToTray, (v) => { setSetting('closeToTray', v); call('set_close_to_tray', { enabled: v }); })),
        setRow('Beim Anmelden starten', 'Startet unauffällig im Tray.', toggle(auto, async (v) => {
          const res = await call('autostart_set', { enabled: v }).catch((e) => toast(`Autostart: ${e}`, { type: 'error' }));
          setSetting('autostart', !!res);
        })),
        setRow('Einrichtung', 'Profil, Freigabe, Qualität und System-Check erneut durchgehen.', h('button.btn', { onclick: () => emit('setup') }, 'Öffnen'))),
    ];
  },

  video() {
    const codecs = availableCodecs();
    const m = cfg.settings.manual;
    const range = (key, min, max, step, unit) => {
      const out = h('span.range-val', `${m[key]} ${unit}`);
      return h('div.range',
        h('input', { type: 'range', min, max, step, value: m[key], oninput: (e) => { out.textContent = `${e.target.value} ${unit}`; }, onchange: (e) => { m[key] = Number(e.target.value); setSetting('manual', m); } }),
        out);
    };
    const manual = h('div.group', { hidden: cfg.settings.quality !== 'manual' }, h('div.list',
      setRow('Bildrate', null, range('fps', 15, 144, 1, 'FPS')),
      setRow('Auflösung', 'Höchstens – kleiner wird automatisch skaliert.', seg([[0, 'Original'], [1440, '1440p'], [1080, '1080p'], [720, '720p']], m.height, (v) => { m.height = v; setSetting('manual', m); })),
      setRow('Bitrate', 'Obergrenze pro Zuschauer.', range('bitrate', 1, 50, 1, 'Mbit/s'))));
    return [
      h('div.group', h('div.group-title', 'Qualität beim Teilen'), options([
        { value: 'auto', title: 'Automatisch', desc: 'Passt sich der Leitung an, bis 60 FPS', icon: 'Sparkles', tag: 'Empfohlen' },
        { value: 'gaming', title: 'Flüssig', desc: 'Bis 120 FPS – für Spiele und Video', icon: 'Gamepad2' },
        { value: 'text', title: 'Scharf', desc: 'Volle Auflösung – für Code und Text', icon: 'FileText' },
        { value: 'saver', title: 'Sparsam', desc: '720p, 30 FPS – schont Akku und Leitung', icon: 'Laptop' },
        { value: 'manual', title: 'Eigene Werte', desc: 'FPS, Auflösung und Bitrate festlegen', icon: 'SlidersHorizontal' },
      ], cfg.settings.quality, (v) => { setSetting('quality', v); manual.hidden = v !== 'manual'; })),
      manual,
      group('Technik',
        setRow('Codec', `Verfügbar: ${codecs.map((c) => (c === 'H264' ? 'H.264' : c)).join(', ') || 'unbekannt'}. H.264 nutzt meist den Hardware-Encoder.`,
          seg([['auto', 'Auto'], ...codecs.map((c) => [c, c === 'H264' ? 'H.264' : c])], cfg.settings.codec, set('codec'))),
        setRow('Systemton übertragen', 'Im Teilen-Dialog zusätzlich „Audio teilen“ wählen.', tog('audio'))),
    ];
  },

  async control() {
    const mons = await call('list_monitors').catch(() => []);
    return [
      group('Wenn jemand beitreten will',
        setRow('Beitritt', '„Freunde“ lässt nur gespeicherte Kontakte fragen, vertraute kommen immer direkt.', seg([['ask', 'Fragen'], ['friends', 'Freunde'], ['auto', 'Alle']], cfg.settings.joinPolicy, set('joinPolicy'))),
        setRow('Fernsteuerung', 'Auch bei „Erlauben“ kannst du sie jederzeit entziehen.', seg([['ask', 'Fragen'], ['auto', 'Erlauben'], ['deny', 'Aus']], cfg.settings.controlPolicy, set('controlPolicy')))),
      group('Beim Zuschauen',
        setRow('Steuerung direkt anfragen', 'Fragt nach dem Verbinden automatisch nach Maus und Tastatur.', tog('autoRequestControl'))),
      group('Mehrere Bildschirme',
        setRow('Monitor für die Steuerung', 'Automatisch erkennt den geteilten Bildschirm an seiner Auflösung.',
          seg([['auto', 'Auto'], ...mons.map((mo, i) => [String(i), `${i + 1} · ${mo.rect.w}×${mo.rect.h}`])], String(cfg.settings.monitor), set('monitor')))),
      h('div.note', icon('ShieldCheck', 17), 'Notbremse:', h('kbd', 'Strg'), h('kbd', 'Shift'), h('kbd', 'X'), 'entzieht sofort die Steuerung und beendet das Teilen – direkt im Backend, auch wenn die App minimiert ist.'),
    ];
  },

  network() {
    const sig = h('input.input', { value: cfg.settings.signaling, placeholder: 'https://peer.example.com/', style: { width: '240px' }, 'aria-label': 'Signaling-Server' });
    return [
      group('Verbindung',
        setRow('Dein Code', 'Bleibt gleich, auch nach Neustarts.', h('div.row-trail', h('span.mono', { style: { fontSize: '15px', fontWeight: 600 } }, fmtCode(cfg.code)), copyButton(() => fmtCode(cfg.code)))),
        setRow('Automatisch neu verbinden', 'Nach einem Abbruch ohne neue Freigabe zurück in die Session.', tog('reconnect')),
        setRow('Im WLAN sichtbar', 'Andere Geräte im selben Netz finden dich (UDP-Port 47821).', tog('lanVisible'))),
      group('Erweitert',
        setRow('Eigener Signaling-Server', 'Optional ein eigener PeerJS-Server. Leer lassen für den Standard.',
          h('div.row-trail', sig, h('button.btn', { onclick: () => { setSetting('signaling', sig.value.trim()); net.start(); toast('Server übernommen', { type: 'ok' }); } }, 'Übernehmen'))),
        setRow('Kompatibilitäts-Modus', 'Bei schwarzem Bild oder Grafikfehlern: Oberfläche ohne GPU.', toggle(cfg.settings.compat, async (v) => {
          setSetting('compat', v);
          if (await confirmDialog({ title: 'Jetzt neu starten?', text: 'Der Modus greift erst nach einem Neustart.', ok: 'Neu starten' })) {
            save();
            setTimeout(() => call('restart'), 300);
          }
        }))),
      group('Daten',
        setRow('Verlauf löschen', null, h('button.btn', { onclick: () => { cfg.history = []; save(); emit('history'); toast('Verlauf gelöscht', { type: 'ok' }); } }, 'Löschen')),
        setRow('Alle Freunde entfernen', null, h('button.btn.danger', { onclick: async () => {
          if (await confirmDialog({ title: 'Alle Freunde entfernen?', text: 'Das lässt sich nicht rückgängig machen.', ok: 'Entfernen', danger: true })) {
            cfg.friends = [];
            save();
            emit('friends');
          }
        } }, 'Entfernen')),
        setRow('Einstellungen zurücksetzen', 'Code, Freunde und Profil bleiben.', h('button.btn', { onclick: async () => {
          if (await confirmDialog({ title: 'Einstellungen zurücksetzen?', ok: 'Zurücksetzen' })) {
            cfg.settings = { ...DEFAULT_SETTINGS };
            save();
            applyTheme();
            Object.keys(DEFAULT_SETTINGS).forEach((key) => emit('settings', { key }));
            toast('Zurückgesetzt', { type: 'ok' });
          }
        } }, 'Zurücksetzen'))),
    ];
  },

  async about() {
    const info = await call('sys_info').catch(() => ({}));
    paintLog();
    return [
      h('div.card.about',
        h('img', { src: '/logo.svg', alt: '', width: 56, height: 56 }),
        h('div', h('h3', 'Screen-Clean'), h('p.muted', `Version ${info.version || '0.1.0'} · ${[info.os, info.arch, info.session].filter(Boolean).join(' · ')}`)),
        h('div.row-trail', { style: { marginLeft: 'auto' } }, h('button.btn', { onclick: () => call('open_url', { url: REPO }) }, icon('Globe', 16), 'GitHub'))),
      group('Tastenkürzel',
        setRow('App zeigen oder verstecken', null, h('div.row-trail', h('kbd', 'Alt'), h('kbd', 'Shift'), h('kbd', 'S'))),
        setRow('Notbremse', null, h('div.row-trail', h('kbd', 'Strg'), h('kbd', 'Shift'), h('kbd', 'X')))),
      h('div.group',
        h('div.group-title', 'Protokoll', h('div.row-trail',
          copyButton(() => logs.map((l) => `${new Date(l.ts).toISOString()} [${l.level}] ${l.msg}`).join('\n'), '.btn.sm.ghost', null, 'Kopieren'),
          h('button.btn.sm.ghost', { onclick: () => call('log_open').catch((e) => toast(String(e), { type: 'warn' })) }, icon('FileText', 15), 'Datei öffnen'))),
        h('div.card', logList)),
    ];
  },
};
