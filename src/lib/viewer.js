// Viewer-Seite: Beitreten, Stream empfangen, Cursor/Eingaben senden,
// Chat – und Auto-Reconnect mit Backoff, wenn die Verbindung abreißt.
import { addHistory, cfg, emit, log } from './store.js';
import { fmtCode, net, toPeerId } from './net.js';
import { preferCodec } from './quality.js';
import { readStats } from './stats.js';

const MAX_ATTEMPTS = 15;

/** Zustände: idle | connecting | waiting | live | reconnecting | ended */
class Viewer {
  state = 'idle';
  info = {};
  code = '';
  conn = null;
  mc = null;
  stream = null;
  host = null;
  color = null;
  list = [];
  cursors = new Map();
  chat = [];
  controlling = false;
  ctlPending = false;
  sharing = false;
  paused = false;
  overlayInCapture = false;
  rtt = null;
  stats = null;
  attempt = 0;
  inputQ = [];
  timers = {};

  constructor() {
    net.handlers.call = (c) => this.onCall(c);
    net.handlers.peerUnavailable = (e) => {
      if (this.code && e.message?.includes(toPeerId(this.code))) this.lost('reason.hostOffline');
    };
    setInterval(() => this.pollStats(), 1000);
  }

  get active() {
    return !['idle', 'ended'].includes(this.state);
  }

  setState(state, info = {}) {
    this.state = state;
    this.info = info;
    emit('viewer:state', { state, ...info });
  }

  join(code) {
    if (code === cfg.code) return 'join.ownCode';
    if (net.state !== 'online') return 'join.notOnline';
    this.leave();
    Object.assign(this, { code, attempt: 0, chat: [], list: [], host: null, endReason: '' });
    this.setState('connecting');
    log(`Verbinde mit ${fmtCode(code)} …`);
    this.connect();
    return '';
  }

  connect() {
    clearTimeout(this.timers.open);
    const conn = net.peer.connect(toPeerId(this.code), { reliable: true, serialization: 'json', metadata: { v: 1 } });
    if (!conn) return this.lost('reason.signaling');
    this.conn = conn;
    conn.on('open', () => {
      if (this.conn !== conn) return;
      conn.send({ t: 'hello', name: cfg.profile.name, color: cfg.profile.color, clientId: cfg.clientId });
    });
    conn.on('data', (m) => this.conn === conn && m && typeof m === 'object' && this.onData(m));
    conn.on('close', () => this.conn === conn && this.lost('reason.closed'));
    conn.on('error', (e) => this.conn === conn && this.lost(e.message));
    this.timers.open = setTimeout(() => this.conn === conn && !conn.open && this.lost('reason.timeout'), 15_000);
  }

  onData(m) {
    switch (m.t) {
      case 'pending':
        this.setState('waiting');
        break;
      case 'welcome':
        Object.assign(this, { host: m.host, color: m.color, chat: m.chat || [], sharing: !!m.sharing, paused: !!m.paused, overlayInCapture: !!m.overlayInCapture, attempt: 0 });
        this.setState('live');
        addHistory(this.code, m.host?.name);
        log(`Verbunden mit ${m.host?.name || fmtCode(this.code)}`);
        emit('viewer:chat');
        this.heartbeat();
        if (cfg.settings.autoRequestControl) setTimeout(() => this.requestControl(), 1000);
        break;
      case 'denied':
        this.end(`reason.${m.code || 'declined'}`);
        break;
      case 'kick':
        this.end('reason.kicked');
        break;
      case 'host-stop':
        this.end('reason.hostStopped');
        break;
      case 'participants':
        this.host = m.host;
        this.list = Array.isArray(m.list) ? m.list : [];
        this.controlling = this.list.some((p) => p.id === net.id && p.ctl);
        emit('viewer:participants');
        break;
      case 'cursors':
        if (!Array.isArray(m.l)) break;
        this.cursors = new Map(m.l.filter((c) => Array.isArray(c) && c[0] !== net.id).map(([id, x, y]) => [id, { x, y }]));
        emit('viewer:cursors');
        break;
      case 'chat':
        this.chat.push(m.msg);
        if (this.chat.length > 200) this.chat.shift();
        emit('viewer:chat', m.msg);
        break;
      case 'react':
        emit('viewer:react', m);
        break;
      case 'control':
        this.ctlPending = !!m.pending;
        if (!m.pending) this.controlling = !!m.granted;
        if (m.code) emit('viewer:notice', `reason.${m.code}`);
        emit('viewer:control');
        break;
      case 'share':
        this.sharing = !!m.sharing;
        this.paused = !!m.paused;
        emit('viewer:share');
        break;
      case 'overlay':
        this.overlayInCapture = !!m.inCapture;
        emit('viewer:cursors');
        break;
      case 'pong':
        this.rtt = performance.now() - m.ts;
        this.lastPong = performance.now();
        break;
    }
  }

  onCall(mc) {
    if (!this.active || mc.peer !== toPeerId(this.code)) return mc.close();
    const old = this.mc;
    this.mc = mc;
    old?.close();
    const codec = mc.metadata?.codec;
    mc.answer(undefined, { sdpTransform: (sdp) => preferCodec(sdp, codec) });
    mc.on('stream', (s) => {
      if (this.mc !== mc) return;
      this.stream = s;
      this.sharing = true;
      this.stats = null;
      emit('viewer:stream', s);
    });
    mc.on('close', () => {
      if (this.mc !== mc) return;
      this.mc = null;
      this.stream = null;
      emit('viewer:stream', null);
    });
  }

  heartbeat() {
    clearInterval(this.timers.hb);
    this.lastPong = performance.now();
    this.timers.hb = setInterval(() => {
      if (!this.conn?.open) return;
      this.conn.send({ t: 'ping', ts: performance.now(), rtt: this.rtt });
      if (performance.now() - this.lastPong > 10_000) this.lost('reason.noPong');
    }, 2000);
  }

  /** Verbindung weg: im Live-Betrieb automatisch neu verbinden, sonst beenden. */
  lost(reason) {
    if (!this.active) return;
    const wasLive = this.state === 'live' || this.state === 'reconnecting';
    this.cleanup();
    if (wasLive && cfg.settings.reconnect && this.attempt < MAX_ATTEMPTS) {
      const ms = Math.min(15_000, 1000 * 2 ** this.attempt++);
      log(`Verbindung verloren (${reason}) – Versuch ${this.attempt} in ${ms / 1000}s`, 'warn');
      this.setState('reconnecting', { reason, attempt: this.attempt, max: MAX_ATTEMPTS, at: Date.now() + ms });
      this.timers.retry = setTimeout(() => (net.state === 'online' ? this.connect() : this.lost('reason.server')), ms);
      return;
    }
    this.end(wasLive ? 'reason.lost' : 'reason.failed', reason);
  }

  retryNow() {
    if (this.state !== 'reconnecting') return;
    clearTimeout(this.timers.retry);
    this.connect();
  }

  cleanup() {
    clearInterval(this.timers.hb);
    clearTimeout(this.timers.open);
    clearTimeout(this.timers.retry);
    const c = this.conn;
    this.conn = null;
    c?.close();
    const mc = this.mc;
    this.mc = null;
    mc?.close();
    Object.assign(this, { stream: null, controlling: false, ctlPending: false, inputQ: [] });
    this.cursors.clear();
    emit('viewer:stream', null);
  }

  /** reason: Schlüssel aus den Sprachdateien, detail: optionaler Unter-Grund. */
  end(reason, detail) {
    this.cleanup();
    log(reason, 'warn');
    this.setState('ended', { reason, detail });
  }

  leave() {
    if (!this.active) return;
    if (this.conn?.open) this.conn.send({ t: 'bye' });
    this.cleanup();
    log('Session verlassen');
    this.setState('idle');
  }

  send(msg) {
    if (this.conn?.open && this.state === 'live') this.conn.send(msg);
  }

  // --- Cursor & Eingaben ---------------------------------------------------
  /** Eigene Position an alle – einmal pro Frame, nicht während man steuert. */
  cursor(x, y) {
    if (this.controlling) return;
    this.nextCursor = { x, y };
    this.timers.cursor ||= requestAnimationFrame(() => {
      this.timers.cursor = 0;
      this.send({ t: 'c', ...this.nextCursor });
    });
  }

  input(ev) {
    if (!this.controlling) return;
    const last = this.inputQ.at(-1);
    if (ev.k === 'move' && last?.k === 'move') this.inputQ[this.inputQ.length - 1] = ev;
    else this.inputQ.push(ev);
    if (!this.timers.input) {
      this.timers.input = setTimeout(() => {
        this.timers.input = null;
        const e = this.inputQ;
        this.inputQ = [];
        if (e.length) this.send({ t: 'i', e });
      }, 8);
    }
  }

  requestControl() {
    if (this.controlling) return;
    this.ctlPending = true;
    this.send({ t: 'req-control' });
    emit('viewer:control');
  }

  releaseControl() {
    this.input({ k: 'mods', m: [false, false, false, false] });
    this.send({ t: 'release-control' });
    this.controlling = false;
    emit('viewer:control');
  }

  sendChat(text) {
    const t = text.trim().slice(0, 1000);
    if (t) this.send({ t: 'chat', text: t });
  }

  react(emoji) {
    this.send({ t: 'react', emoji });
  }

  async pollStats() {
    if (!this.mc?.peerConnection || !this.stream) return;
    this.stats = await readStats(this.mc.peerConnection, 'in', this.stats);
    if (this.stats) this.stats.ping = this.rtt != null ? Math.round(this.rtt) : this.stats.rtt;
    emit('viewer:stats', this.stats);
  }
}

export const viewer = new Viewer();
