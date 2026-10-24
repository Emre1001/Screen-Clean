/* Language picker: a dropdown window opened from a "Sprache" row in settings. Needs i18n.js and
   language-picker.css (which use the theme tokens). Languages are never shown as visible buttons.

   <button class="lang-trigger" id="lang-trigger" type="button" aria-haspopup="dialog" aria-expanded="false">
     <span data-lang-current></span>
     <svg class="lang-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 8l5 5 5-5"/></svg>
   </button>

   initLanguagePicker(document.getElementById('lang-trigger'));

   Behaviour: anchored popover on desktop (flips upward when there is no room below, aligns to the
   trigger's inline-end edge, scales out of the trigger), bottom sheet on phones, search field once the
   list is long, full keyboard support, selection check-mark that draws itself, soft crossfade when the
   language switches. Native names only (Deutsch, Türkçe, ...), no flags. */
(function (global) {
  'use strict';

  var CHECK = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 10.5l3.5 3.5 7.5-8"/></svg>';
  var uid = 0;

  function el(tag, cls) { var n = document.createElement(tag); if (cls) n.className = cls; return n; }

  function initLanguagePicker(trigger, options) {
    var searchFrom = (options && options.searchFrom) || 8;
    var label = trigger.querySelector('[data-lang-current]');
    var english = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['en'], { type: 'language' }) : null;
    var sheetQuery = matchMedia('(max-width: 520px)');
    var id = 'lang' + (++uid);

    var pop = null, backdrop = null, search = null, list = null;
    var shown = [], active = -1, isOpen = false, closeTimer = 0;

    function syncLabel() { if (label) label.textContent = I18n.nameOf(I18n.current()); }
    syncLabel();
    I18n.onChange(syncLabel);

    function englishName(code) {
      if (!english) return '';
      try { return english.of(code) || ''; } catch (e) { return ''; }
    }

    function allRows() {
      var rows = [{ value: 'system', primary: I18n.t('language.system'), secondary: I18n.nameOf(I18n.resolve('system')) }];
      I18n.languages().forEach(function (l) {
        var en = englishName(l.code);
        rows.push({ value: l.code, primary: l.name, secondary: en && en !== l.name ? en : '' });
      });
      return rows;
    }

    function setActive(i, scroll) {
      active = i;
      var focusEl = search || list;
      Array.prototype.forEach.call(list.children, function (c, idx) { c.classList.toggle('is-active', idx === i); });
      var item = list.children[i];
      if (item && item.id) {
        focusEl.setAttribute('aria-activedescendant', item.id);
        if (scroll !== false) item.scrollIntoView({ block: 'nearest' });
      } else {
        focusEl.removeAttribute('aria-activedescendant');
      }
    }

    function render(query, enter) {
      if (!list) return;
      var locale = I18n.current();
      var q = query.trim().toLocaleLowerCase(locale);
      var chosen = I18n.preference();
      shown = allRows().filter(function (r) {
        // the "system language" row only matches its own label, so typing "deu" finds Deutsch, not "Systemsprache"
        var hay = r.value === 'system' ? r.primary : r.primary + ' ' + r.secondary;
        return !q || hay.toLocaleLowerCase(locale).indexOf(q) !== -1;
      });
      list.textContent = '';

      if (!shown.length) {
        var empty = el('div', 'lang-empty');
        empty.textContent = I18n.t('language.noResults');
        list.appendChild(empty);
        setActive(-1);
        return;
      }

      shown.forEach(function (r, i) {
        var item = el('div', 'lang-item');
        item.id = id + '-opt-' + i;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(r.value === chosen));
        if (enter) { item.classList.add('is-enter'); item.style.setProperty('--i', String(i)); }

        var text = el('span', 'lang-text');
        var primary = el('span', 'lang-primary');
        primary.textContent = r.primary;
        if (r.value !== 'system') primary.lang = r.value;   // correct font and shaping even if the UI is in another language
        text.appendChild(primary);
        if (r.secondary) {
          var secondary = el('span', 'lang-secondary');
          secondary.textContent = r.secondary;
          text.appendChild(secondary);
        }

        var check = el('span', 'lang-check');
        check.innerHTML = CHECK;                              // static markup, no user data
        item.appendChild(text);
        item.appendChild(check);

        item.addEventListener('click', function () { choose(r.value); });
        item.addEventListener('pointermove', function () { if (active !== i) setActive(i, false); });
        list.appendChild(item);
      });

      // empty search: start on the current language; while searching: start on the first match, so Enter picks it
      var selected = q ? -1 : shown.findIndex(function (r) { return r.value === chosen; });
      setActive(selected >= 0 ? selected : 0);
    }

    function place() {
      var margin = 12;
      var r = trigger.getBoundingClientRect();
      var rtl = document.documentElement.dir === 'rtl';
      var below = innerHeight - r.bottom - margin - 8;
      var above = r.top - margin - 8;

      pop.style.maxHeight = '';
      var naturalHeight = pop.offsetHeight;
      var up = naturalHeight > below && above > below;
      var room = Math.max(160, up ? above : below);
      pop.style.maxHeight = room + 'px';

      var w = pop.offsetWidth;
      var h = Math.min(naturalHeight, room);
      var left = rtl ? r.left : r.right - w;
      left = Math.max(margin, Math.min(left, innerWidth - w - margin));
      var top = up ? r.top - h - 8 : r.bottom + 8;

      pop.style.left = left + 'px';
      pop.style.top = top + 'px';
      pop.style.transformOrigin = (r.left + r.width / 2 - left) + 'px ' + (up ? '100%' : '0');
      pop.classList.toggle('is-up', up);
    }

    function onKey(e) {
      if (!isOpen) return;
      var n = shown.length;
      switch (e.key) {
        case 'ArrowDown': e.preventDefault(); if (n) setActive((active + 1) % n); break;
        case 'ArrowUp': e.preventDefault(); if (n) setActive((active - 1 + n) % n); break;
        case 'Home': if (!search && n) { e.preventDefault(); setActive(0); } break;
        case 'End': if (!search && n) { e.preventDefault(); setActive(n - 1); } break;
        case 'Enter': e.preventDefault(); if (active >= 0 && shown[active]) choose(shown[active].value); break;
        case 'Escape': e.preventDefault(); e.stopPropagation(); close(); break;
        case 'Tab': close(false); break;
      }
    }

    function open() {
      if (isOpen) return;
      clearTimeout(closeTimer);
      isOpen = true;
      trigger.setAttribute('aria-expanded', 'true');
      var sheet = sheetQuery.matches;

      backdrop = el('div', 'lang-backdrop' + (sheet ? ' is-sheet' : ''));
      pop = el('div', 'lang-pop' + (sheet ? ' is-sheet' : ''));
      pop.setAttribute('role', 'dialog');
      pop.setAttribute('aria-label', I18n.t('language.title'));

      list = el('div', 'lang-list');
      list.setAttribute('role', 'listbox');
      list.setAttribute('aria-label', I18n.t('language.title'));

      if (I18n.languages().length + 1 >= searchFrom) {
        var wrap = el('div', 'lang-search');
        search = el('input');
        search.type = 'search';
        search.autocomplete = 'off';
        search.setAttribute('role', 'combobox');
        search.setAttribute('aria-expanded', 'true');
        search.setAttribute('aria-controls', id + '-list');
        search.setAttribute('aria-autocomplete', 'list');
        search.setAttribute('aria-label', I18n.t('language.search'));
        search.placeholder = I18n.t('language.search');
        search.addEventListener('input', function () { render(search.value, false); });
        wrap.appendChild(search);
        pop.appendChild(wrap);
      } else {
        search = null;
        list.tabIndex = 0;
      }
      list.id = id + '-list';
      pop.appendChild(list);

      document.body.appendChild(backdrop);
      document.body.appendChild(pop);
      render('', true);
      if (!sheet) place();

      requestAnimationFrame(function () {
        if (!pop) return;
        backdrop.classList.add('is-open');
        pop.classList.add('is-open');
      });
      (search || list).focus({ preventScroll: true });

      backdrop.addEventListener('pointerdown', function () { close(); });
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('resize', onResize);
    }

    function onResize() { close(false); }

    function close(restoreFocus) {
      if (!isOpen) return;
      isOpen = false;
      trigger.setAttribute('aria-expanded', 'false');
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);

      var p = pop, b = backdrop;
      p.classList.remove('is-open');
      b.classList.remove('is-open');
      closeTimer = setTimeout(function () { p.remove(); b.remove(); }, 380);
      pop = backdrop = search = list = null;
      if (restoreFocus !== false) trigger.focus({ preventScroll: true });
    }

    function choose(value) {
      close();
      // Let the dropdown start leaving first, so the crossfade does not capture it.
      setTimeout(function () { I18n.setLanguage(value); }, 160);
    }

    trigger.addEventListener('click', function () { if (isOpen) close(); else open(); });
    trigger.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' && !isOpen) { e.preventDefault(); open(); }
    });

    return { open: open, close: close };
  }

  global.initLanguagePicker = initLanguagePicker;
})(window);
