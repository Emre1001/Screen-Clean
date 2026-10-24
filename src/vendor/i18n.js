/* Tiny i18n runtime. No dependencies and no fetch, so it works on file://, in Electron with a strict
   Content-Security-Policy, in Tauri and in Capacitor.

   Locale files call I18n.register('xx', { key: 'text' }, { name: 'Native name', dir: 'ltr' }) and are
   loaded with plain <script> tags (see locales/). The picker lists languages in registration order.

   Markup:   <h1 data-i18n="settings.title"></h1>
             <input data-i18n-attr="placeholder:search.placeholder;aria-label:search.label">
   Code:     I18n.t('update.body', { version: '1.4.0', current: '1.3.2' })
             I18n.t('items.count', { count: 3 })   // picks items.count_one / _other / _few ... (Intl.PluralRules)

   Call I18n.init() after the DOM exists (scripts at the end of <body>, or in renderer.js). */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'lang';
  var FALLBACK = 'en';
  var dict = Object.create(null);
  var meta = [];
  var listeners = new Set();
  var current = FALLBACK;
  var pref = 'system';
  var rules = new Intl.PluralRules(FALLBACK);
  var fallbackRules = new Intl.PluralRules(FALLBACK);
  var numberFormat = new Intl.NumberFormat(FALLBACK);

  function reduceMotion() { return matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function readPref() { try { return localStorage.getItem(STORAGE_KEY) || 'system'; } catch (e) { return 'system'; } }
  function writePref(v) { try { localStorage.setItem(STORAGE_KEY, v); } catch (e) { /* storage can be blocked */ } }

  function register(code, messages, info) {
    info = info || {};
    dict[code] = Object.assign(dict[code] || {}, messages);
    if (!meta.some(function (m) { return m.code === code; })) {
      meta.push({ code: code, name: info.name || code, dir: info.dir || 'ltr' });
    }
  }

  function languages() { return meta.slice(); }
  function has(code) { return !!dict[code]; }
  function nameOf(code) {
    var m = meta.find(function (x) { return x.code === code; });
    return m ? m.name : code;
  }

  // 'system' -> best match from navigator.languages (exact tag, then base language), else English.
  function resolve(choice) {
    if (choice && choice !== 'system' && has(choice)) return choice;
    var wanted = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || FALLBACK];
    for (var i = 0; i < wanted.length; i++) {
      var tag = String(wanted[i]).toLowerCase();
      var exact = meta.find(function (m) { return m.code.toLowerCase() === tag; });
      if (exact) return exact.code;
      var base = meta.find(function (m) { return m.code.toLowerCase() === tag.split('-')[0]; });
      if (base) return base.code;
    }
    return has(FALLBACK) ? FALLBACK : (meta[0] ? meta[0].code : FALLBACK);
  }

  function find(code, pluralRules, key, count) {
    var d = dict[code];
    if (!d) return undefined;
    if (typeof count === 'number') {
      var forms = [pluralRules.select(count), 'other'];
      for (var i = 0; i < forms.length; i++) {
        if (d[key + '_' + forms[i]] !== undefined) return d[key + '_' + forms[i]];
      }
    }
    return d[key];
  }

  function t(key, params) {
    var count = params && typeof params.count === 'number' ? params.count : undefined;
    var msg = find(current, rules, key, count);
    if (msg === undefined && current !== FALLBACK) msg = find(FALLBACK, fallbackRules, key, count);
    if (msg === undefined) return key;        // a visible, greppable gap instead of an empty label
    if (!params) return msg;
    return msg.replace(/\{(\w+)\}/g, function (whole, name) {
      if (!(name in params)) return whole;
      var v = params[name];
      return typeof v === 'number' ? numberFormat.format(v) : String(v);
    });
  }

  // textContent only, never innerHTML: translated strings are plain text.
  function apply(root) {
    root = root || document;
    root.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    root.querySelectorAll('[data-i18n-attr]').forEach(function (el) {
      el.getAttribute('data-i18n-attr').split(';').forEach(function (pair) {
        var i = pair.indexOf(':');
        if (i > 0) el.setAttribute(pair.slice(0, i).trim(), t(pair.slice(i + 1).trim()));
      });
    });
  }

  // choice: 'system' or a language code. Persists the choice, sets <html lang dir>, re-renders, notifies.
  function setLanguage(choice, opts) {
    pref = choice || 'system';
    writePref(pref);
    var next = resolve(pref);
    var root = document.documentElement;

    function run() {
      current = next;
      rules = new Intl.PluralRules(next);
      numberFormat = new Intl.NumberFormat(next);
      var info = meta.find(function (m) { return m.code === next; });
      root.lang = next;
      root.dir = (info && info.dir) || 'ltr';
      apply();
      listeners.forEach(function (fn) { fn(next); });
    }

    var animate = !(opts && opts.animate === false) && next !== current &&
      typeof document.startViewTransition === 'function' && !reduceMotion();
    if (!animate) { run(); return; }

    root.classList.add('lang-switching');
    document.startViewTransition(run).finished.finally(function () { root.classList.remove('lang-switching'); });
  }

  function init(options) {
    setLanguage((options && options.language) || readPref(), { animate: false });
  }

  function onChange(fn) { listeners.add(fn); return function () { listeners.delete(fn); }; }

  // Locale-aware helpers. Never build numbers, dates or casing by hand.
  function number(n, o) { return new Intl.NumberFormat(current, o).format(n); }
  function date(d, o) { return new Intl.DateTimeFormat(current, o || { dateStyle: 'medium' }).format(d); }
  function relative(value, unit, o) { return new Intl.RelativeTimeFormat(current, o || { numeric: 'auto' }).format(value, unit); }
  function upper(s) { return String(s).toLocaleUpperCase(current); }   // Turkish: i -> İ, not I
  function lower(s) { return String(s).toLocaleLowerCase(current); }   // Turkish: I -> ı

  global.I18n = {
    register: register, languages: languages, has: has, nameOf: nameOf, resolve: resolve,
    t: t, apply: apply, init: init, setLanguage: setLanguage, onChange: onChange,
    current: function () { return current; },
    preference: function () { return pref; },
    number: number, date: date, relative: relative, upper: upper, lower: lower
  };
})(window);
