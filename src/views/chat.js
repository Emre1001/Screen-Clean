// Chat – derselbe Baustein für Host (Teilen) und Viewer (Session-Panel).
import { call } from '../lib/bridge.js';
import { REACTIONS } from '../lib/host.js';
import { onEvent } from '../lib/store.js';
import { avatar, h, icon, linkify } from '../lib/ui.js';

const time = (ts) => new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const openUrl = (url) => call('open_url', { url });

/** source = { messages(): Msg[], send(text), react(emoji), isMine(msg), event } */
export function chatPanel(source) {
  const list = h('div.chat-list', { role: 'log', 'aria-live': 'polite' });
  const send = h('button.send', { type: 'button', 'aria-label': 'Senden', disabled: true, onclick: () => submit() }, icon('ArrowRight', 17));
  const input = h('textarea.chat-input', {
    rows: 1,
    maxlength: 1000,
    placeholder: 'Nachricht',
    'aria-label': 'Nachricht',
    onkeydown: (e) => {
      e.stopPropagation(); // nie an die Fernsteuerung durchreichen
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    },
    onkeyup: (e) => e.stopPropagation(),
    oninput: () => {
      send.disabled = !input.value.trim();
      autosize();
    },
  });
  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  };
  const submit = () => {
    if (!input.value.trim()) return;
    source.send(input.value);
    input.value = '';
    send.disabled = true;
    autosize();
  };

  let shown = 0;
  const render = () => {
    const msgs = source.messages();
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    if (!msgs.length) {
      shown = 0;
      list.replaceChildren(h('div.empty', { style: { margin: 'auto' } }, icon('MessageCircle', 26), h('b', 'Noch ruhig hier'), h('span', 'Schreib die erste Nachricht.')));
      return;
    }
    if (shown === 0 || msgs.length < shown) list.replaceChildren();
    // nur neue Nachrichten anhängen – alte bleiben stehen, nichts flackert
    for (let i = shown; i < msgs.length; i++) {
      const m = msgs[i];
      const prev = msgs[i - 1];
      const grouped = prev && prev.from === m.from && m.ts - prev.ts < 120_000;
      list.append(h(`div.msg${grouped ? '.grouped' : ''}`,
        grouped ? h('span.avatar-gap') : avatar(m.name, m.color, 26),
        h('div.bubble',
          !grouped && h('div.meta', h('b', m.name), h('time', time(m.ts))),
          h('div.text', linkify(m.text, openUrl)))));
    }
    shown = msgs.length;
    if (atBottom || source.isMine(msgs.at(-1))) list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
  };

  onEvent(source.event, render);
  render();

  const el = h('div.chat',
    list,
    h('div.reactions', REACTIONS.map((e) => h('button.react', { type: 'button', 'aria-label': `Reaktion ${e}`, onclick: () => source.react(e) }, e))),
    h('div.chat-compose', input, send));
  el.focusInput = () => input.focus();
  el.refresh = () => { shown = 0; render(); };
  return el;
}
