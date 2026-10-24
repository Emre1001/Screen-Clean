/* In-app update popup, shared by every platform. Needs i18n.js (with the update.* strings from
   locales/) and update-dialog.css. Each platform only supplies an adapter:

     adapter.mode              'desktop' (default) | 'android' | 'web'
     adapter.check()           -> Promise< null | { version, current, notes } >      notes: plain text
     adapter.install(onProgress) -> Promise<void>
                                 downloads and installs; onProgress({ percent: 0-100 }).
                                 desktop: resolves right before the app restarts
                                 android: resolves once the system install prompt has been opened
     adapter.cancel()          -> optional, aborts a running download

   UpdateUI.init({ adapter, currentVersion })       schedules the automatic checks
   UpdateUI.check({ manual: true })                 'available' | 'none' | 'suppressed' | 'busy' | 'error'
   UpdateUI.bindSettings(rootEl)                    wires the Updates section of the settings page
   UpdateUI.mockAdapter({ durationMs, fail, none }) fake adapter to design and test the popup without a release

   Popup actions: Install, Later (asks again after a day), Skip this update (silent until a newer version). */
(function (global) {
  'use strict';

  var K_SKIPPED = 'update.skipped';
  var K_REMIND = 'update.remindAfter';
  var K_AUTO = 'update.auto';
  var ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"/><path d="M7.5 11l4.5 4.5 4.5-4.5"/><path d="M5 19.5h14"/></svg>';
  var PRIMARY = { available: 'install', downloading: 'cancel', handoff: 'close', error: 'retry' };   // gets the focus
  var STATES = {
    available: ['later', 'install', 'skip'],
    downloading: ['cancel'],
    installing: [],
    handoff: ['close'],
    error: ['close', 'retry']
  };

  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage can be blocked */ } }
  };
  function t(k, p) { return global.I18n.t(k, p); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  var cfg = { adapter: null, autoCheck: true, firstDelayMs: 5000, everyHours: 6, remindAfterHours: 24, currentVersion: '' };
  var ui = null;
  var checking = false;
  var cancelled = false;
  var uid = 0;

  function autoEnabled() { return store.get(K_AUTO) !== '0'; }

  /* ---------- Checking ---------- */
  function check(opts) {
    var manual = !!(opts && opts.manual);
    if (!cfg.adapter) return Promise.resolve('error');
    if (checking || ui) return Promise.resolve('busy');
    checking = true;
    return Promise.resolve()
      .then(function () { return cfg.adapter.check(); })
      .then(function (info) {
        if (!info) return 'none';
        if (!manual) {
          if (store.get(K_SKIPPED) === info.version) return 'suppressed';
          if (Number(store.get(K_REMIND) || 0) > Date.now()) return 'suppressed';
        }
        openDialog(info);
        return 'available';
      })
      .catch(function (err) { console.error('[update] check failed', err); return 'error'; })
      .then(function (result) { checking = false; return result; });
  }

  function init(options) {
    cfg = Object.assign(cfg, options || {});
    if (cfg.autoCheck) {
      setTimeout(function () { if (autoEnabled()) check(); }, cfg.firstDelayMs);
      setInterval(function () { if (autoEnabled()) check(); }, cfg.everyHours * 3600 * 1000);
    }
  }

  /* ---------- Dialog ---------- */
  function openDialog(info) {
    var id = 'upd' + (++uid);
    var overlay = el('div', 'upd-overlay');
    var card = el('div', 'upd-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', id + '-title');
    card.setAttribute('aria-describedby', id + '-body');

    var icon = el('div', 'upd-icon');
    icon.innerHTML = ICON;                                // static markup
    var title = el('h2', 'upd-title');
    title.id = id + '-title';
    var body = el('p', 'upd-body');
    body.id = id + '-body';

    var notes = el('div', 'upd-notes');
    notes.appendChild(el('span', 'upd-notes-label', t('update.notes')));
    notes.appendChild(el('pre', 'upd-notes-text', info.notes || ''));   // textContent: release notes are never parsed as HTML

    var progress = el('div', 'upd-progress');
    var track = el('div', 'upd-track');
    var bar = el('div', 'upd-bar');
    track.appendChild(bar);
    var percent = el('span', 'upd-percent');
    progress.appendChild(track);
    progress.appendChild(percent);

    var actions = el('div', 'upd-actions');
    var buttons = {
      later: button('upd-btn upd-btn--secondary', t('update.later'), later),
      install: button('upd-btn upd-btn--primary', t('update.install'), startInstall),
      skip: button('upd-btn upd-btn--ghost', t('update.skip'), skip),
      cancel: button('upd-btn upd-btn--secondary', t('common.cancel'), cancel),
      close: button('upd-btn upd-btn--secondary', t('common.close'), closeDialog),
      retry: button('upd-btn upd-btn--primary', t('update.retry'), startInstall)
    };
    Object.keys(buttons).forEach(function (k) { actions.appendChild(buttons[k]); });

    [icon, title, body, notes, progress, actions].forEach(function (n) { card.appendChild(n); });
    overlay.appendChild(card);

    ui = {
      info: info, overlay: overlay, card: card, title: title, body: body, notes: notes,
      progress: progress, bar: bar, percent: percent, buttons: buttons,
      state: 'available', previousFocus: document.activeElement
    };

    document.body.appendChild(overlay);
    setState('available');
    document.addEventListener('keydown', onKey, true);
    requestAnimationFrame(function () { if (ui) ui.overlay.classList.add('is-open'); });
  }

  function button(cls, text, handler) {
    var b = el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', handler);
    return b;
  }

  function setState(state) {
    if (!ui) return;
    ui.state = state;
    var info = ui.info;
    var versions = { version: info.version, current: info.current || cfg.currentVersion };

    var copy = {
      available: [t('update.title'), t('update.body', versions)],
      downloading: [t('update.downloading'), t('update.version', versions)],
      installing: [t('update.installing'), t('update.installing.hint')],
      handoff: [t('update.handoff.title'), t('update.handoff')],
      error: [t('update.error'), t('update.errorBody')]
    }[state];
    ui.title.textContent = copy[0];
    ui.body.textContent = copy[1];

    ui.notes.hidden = !(state === 'available' && info.notes);
    ui.progress.hidden = !(state === 'downloading' || state === 'installing');
    if (state === 'installing') {
      ui.progress.classList.add('is-indeterminate');
      ui.percent.textContent = '';
    }
    if (state === 'downloading') setProgress(null);

    var visible = STATES[state];
    Object.keys(ui.buttons).forEach(function (k) { ui.buttons[k].hidden = visible.indexOf(k) === -1; });
    ui.card.dataset.state = state;

    if (PRIMARY[state]) ui.buttons[PRIMARY[state]].focus({ preventScroll: true });
  }

  function setProgress(p) {
    if (!ui) return;
    var pct = p && typeof p.percent === 'number' ? Math.max(0, Math.min(100, p.percent)) : null;
    ui.progress.classList.toggle('is-indeterminate', pct === null);
    if (pct === null) { ui.percent.textContent = ''; return; }
    ui.bar.style.setProperty('--p', String(pct / 100));
    ui.percent.textContent = global.I18n.number(pct / 100, { style: 'percent', maximumFractionDigits: 0 });
  }

  function startInstall() {
    if (!ui) return;
    cancelled = false;
    setState('downloading');
    Promise.resolve()
      .then(function () { return cfg.adapter.install(setProgress); })
      .then(function () { if (!cancelled) setState(cfg.adapter.mode === 'android' ? 'handoff' : 'installing'); })
      .catch(function (err) {
        if (cancelled) return;
        console.error('[update] install failed', err);
        setState('error');
      });
  }

  function later() {
    store.set(K_REMIND, String(Date.now() + cfg.remindAfterHours * 3600 * 1000));
    closeDialog();
  }
  function skip() {
    if (ui) store.set(K_SKIPPED, ui.info.version);
    closeDialog();
  }
  function cancel() {
    cancelled = true;
    try { if (cfg.adapter.cancel) cfg.adapter.cancel(); } catch (e) { /* nothing to cancel */ }
    closeDialog();
  }

  function closeDialog() {
    if (!ui) return;
    var current = ui;
    ui = null;
    document.removeEventListener('keydown', onKey, true);
    current.overlay.classList.remove('is-open');
    setTimeout(function () { current.overlay.remove(); }, 380);
    var prev = current.previousFocus;
    if (prev && typeof prev.focus === 'function' && document.contains(prev)) prev.focus({ preventScroll: true });
  }

  function onKey(e) {
    if (!ui) return;
    if (e.key === 'Escape') {
      if (ui.state === 'available') { e.preventDefault(); later(); }
      else if (ui.state === 'error' || ui.state === 'handoff') { e.preventDefault(); closeDialog(); }
      return;
    }
    if (e.key === 'Tab') {                               // keep focus inside the popup
      var items = STATES[ui.state].map(function (k) { return ui.buttons[k]; });
      if (!items.length) { e.preventDefault(); return; }
      var i = items.indexOf(document.activeElement);
      e.preventDefault();
      var next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i === -1 || i === items.length - 1 ? 0 : i + 1);
      items[next].focus({ preventScroll: true });
    }
  }

  /* ---------- Settings section ---------- */
  function bindSettings(root) {
    root = root || document;
    var btn = root.querySelector('[data-update-check]');
    var status = root.querySelector('[data-update-status]');
    var ver = root.querySelector('[data-update-version]');
    var auto = root.querySelector('[data-update-auto]');

    function showVersion() { if (ver) ver.textContent = t('update.version', { version: cfg.currentVersion || '' }); }
    showVersion();
    global.I18n.onChange(function () { showVersion(); if (status) status.textContent = ''; });

    if (btn) {
      btn.addEventListener('click', function () {
        btn.disabled = true;
        if (status) status.textContent = t('update.checking');
        check({ manual: true }).then(function (result) {
          btn.disabled = false;
          if (!status) return;
          status.textContent = result === 'none' ? t('update.upToDate', { current: cfg.currentVersion || '' })
            : result === 'error' ? t('update.checkFailed') : '';
        });
      });
    }
    if (auto) {
      auto.setAttribute('aria-checked', String(autoEnabled()));
      auto.addEventListener('click', function () {
        var on = !autoEnabled();
        store.set(K_AUTO, on ? '1' : '0');
        auto.setAttribute('aria-checked', String(on));
      });
    }
  }

  /* ---------- Mock adapter for design and tests ---------- */
  function mockAdapter(o) {
    o = o || {};
    var timer = 0;
    return {
      mode: o.mode || 'desktop',
      check: function () {
        return new Promise(function (resolve) {
          setTimeout(function () {
            resolve(o.none ? null : {
              version: o.version || '9.9.9',
              current: o.current || '1.0.0',
              notes: o.notes || '• Faster start\n• New language picker\n• Fixed a crash when resuming from sleep'
            });
          }, 300);
        });
      },
      install: function (onProgress) {
        return new Promise(function (resolve, reject) {
          var t0 = Date.now();
          var total = o.durationMs || 3000;
          timer = setInterval(function () {
            var pct = Math.min(100, ((Date.now() - t0) / total) * 100);
            onProgress({ percent: pct });
            if (pct >= 100) {
              clearInterval(timer);
              if (o.fail) reject(new Error('Simulated failure')); else resolve();
            }
          }, 60);
        });
      },
      cancel: function () { clearInterval(timer); }
    };
  }

  global.UpdateUI = { init: init, check: check, bindSettings: bindSettings, mockAdapter: mockAdapter };
})(window);
