// Bedienelemente. Alle ändern ihren Zustand an Ort und Stelle (kein Neu-
// Rendern), damit Übergänge sichtbar bleiben.
import { h, icon, onColor, t } from '../lib/ui.js';
import { PALETTE } from '../lib/store.js';

export function toggle(checked, onchange, label) {
  const input = h('input', { type: 'checkbox', checked, onchange: (e) => onchange(e.target.checked) });
  return h('label.switch', input, h('span.track', h('span.thumb')), label && h('span', label));
}

/** Segment-Steuerung mit gleitendem Daumen: options = [[value, label, icon?], …] */
export function seg(options, value, onchange, cls = '') {
  const el = h(`div.seg${cls}`, { role: 'radiogroup' }, h('span.seg-thumb'));
  const btns = options.map(([val, label, ic]) => {
    const b = h('button', { type: 'button', role: 'radio', onclick: () => { select(val, true); onchange(val); } }, ic && icon(ic, 15), label);
    b.dataset.v = String(val);
    el.append(b);
    return b;
  });
  let cur = value;
  const place = (animate) => {
    const b = btns.find((x) => x.dataset.v === String(cur));
    if (!b || !b.offsetWidth) return;
    el.classList.toggle('no-anim', !animate);
    el.style.setProperty('--x', `${b.offsetLeft}px`);
    el.style.setProperty('--w', `${b.offsetWidth}px`);
  };
  function select(v, animate) {
    cur = v;
    for (const b of btns) {
      const on = b.dataset.v === String(v);
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
    place(animate);
  }
  select(value, false);
  new ResizeObserver(() => place(false)).observe(el);
  el.set = (v) => select(v, true);
  return el;
}

/** Auswahlkarten: opts = [{ value, title, desc, icon, tag }] */
export function options(opts, value, onchange) {
  const el = h('div.options', { role: 'radiogroup' });
  const btns = opts.map((o) => {
    const b = h('button.option', { type: 'button', role: 'radio', onclick: () => { select(o.value); onchange(o.value); } },
      icon(o.icon, 20),
      h('b', o.title, o.tag ? h('span.badge.accent', { style: { marginLeft: '6px' } }, o.tag) : null),
      o.desc && h('span', o.desc),
      h('span.check', icon('Check', 12)));
    b.dataset.v = String(o.value);
    el.append(b);
    return b;
  });
  function select(v) {
    for (const b of btns) {
      b.classList.toggle('on', b.dataset.v === String(v));
      b.setAttribute('aria-checked', String(b.dataset.v === String(v)));
    }
  }
  select(value);
  return el;
}

export function setRow(title, desc, control) {
  return h('div.row.set-row', h('div.set-text', h('div.set-title', title), desc && h('div.set-desc', desc)), control);
}

/** Code-Kacheln; .set(code) klappt sie nacheinander um. */
export function codeTiles(code, lg = false) {
  const el = h(`div.tiles${lg ? '.lg' : ''}`, { 'aria-label': `Code ${code}` });
  const tiles = [];
  for (let i = 0; i < 6; i++) {
    if (i === 3) el.append(h('span.sep'));
    const tile = h('span.tile', { style: { '--i': i } });
    tiles.push(tile);
    el.append(tile);
  }
  el.set = (c, animate = true) => {
    el.setAttribute('aria-label', `Code ${c}`);
    tiles.forEach((t, i) => {
      t.textContent = (c || '------')[i];
      if (!animate) return;
      t.classList.remove('flip');
      void t.offsetWidth;
      t.classList.add('flip');
    });
  };
  el.set(code, false);
  return el;
}

export function swatches(value, onchange) {
  const el = h('div.swatches', { role: 'radiogroup', 'aria-label': t('profile.color') });
  const btns = PALETTE.map((c) => {
    const b = h('button.swatch', { type: 'button', style: { '--c': c }, 'aria-label': c, onclick: () => { select(c); onchange(c); } });
    el.append(b);
    return [c, b];
  });
  const select = (v) => btns.forEach(([c, b]) => b.classList.toggle('on', c === v));
  select(value);
  return el;
}

/**
 * Ebene für fremde Cursor. Positionen kommen in Sprüngen übers Netz (~60/s);
 * jeder Frame gleitet ein Stück zum Ziel – wirkt flüssig, kostet kaum Latenz.
 * sync([{ id, x, y, name, color }]) mit x/y normalisiert (0..1).
 */
export function cursorLayer(layer) {
  const items = new Map();
  let w = layer.clientWidth;
  let hh = layer.clientHeight;
  let raf = 0;
  const kick = () => (raf ||= requestAnimationFrame(frame));
  function frame() {
    raf = 0;
    let moving = false;
    for (const it of items.values()) {
      const dx = it.tx - it.x;
      const dy = it.ty - it.y;
      if (Math.abs(dx) + Math.abs(dy) > 0.0004) {
        it.x += dx * 0.5;
        it.y += dy * 0.5;
        moving = true;
      } else {
        it.x = it.tx;
        it.y = it.ty;
      }
      it.el.style.transform = `translate3d(${it.x * w}px, ${it.y * hh}px, 0)`;
    }
    if (moving) kick();
  }
  new ResizeObserver(() => {
    w = layer.clientWidth;
    hh = layer.clientHeight;
    kick();
  }).observe(layer);
  return {
    sync(list) {
      const seen = new Set();
      for (const c of list) {
        seen.add(c.id);
        const key = `${c.name}${c.color}`;
        let it = items.get(c.id);
        if (!it || it.key !== key) {
          it?.el.remove();
          it = { el: cursorEl(c.name, c.color), key, x: c.x, y: c.y };
          layer.append(it.el);
          items.set(c.id, it);
        }
        it.tx = c.x;
        it.ty = c.y;
      }
      for (const [id, it] of items) {
        if (!seen.has(id)) {
          it.el.remove();
          items.delete(id);
        }
      }
      kick();
    },
  };
}

/** Farbiger Cursor mit Namens-Label – identisch in Stage, Overlay und Website. */
export function cursorEl(name, color, ctl = false) {
  return h(`div.rcursor${ctl ? '.ctl' : ''}`, { style: { '--c': color, '--on': onColor(color) } }, cursorSvg(), h('span.label', name));
}

export function cursorSvg() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 26 40');
  svg.setAttribute('width', '17');
  svg.setAttribute('height', '26');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', 'M2 2 L2 32 L9.5 25 L14.5 37 L20 34.5 L15 23 L25 23 Z');
  svg.append(p);
  return svg;
}
