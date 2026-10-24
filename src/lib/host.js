// Host-Seite: Beitrittsanfragen, Stream an alle Viewer, Steuerungs-Übergabe,
// Cursor-Verteilung, Chat. Der Host ist Hub – Viewer reden nur mit ihm.
import { call, emitTo } from './bridge.js';
import { cfg, emit, findFriend, log, onEvent, PALETTE } from './store.js';
import { fromPeerId, net } from './net.js';
import { applyToSender, applyToTrack, captureOptions, preferCodec } from './quality.js';
import { readStats } from './stats.js';

export const REACTIONS = ['👍', '😂', '🔥', '👀', '❤️', '🎉', '😮', '👏'];
const MAX_CHAT = 200;
const REJOIN_MS = 10 * 60_000;

const clean = (s, n) => (typeof s === 'string' ? s.trim().slice(0, n) : '');
const isColor = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);
const unit = (v) => typeof v === 'number' && v >= 0 && v <= 1;

class Host {
  viewers = new Map(); // peerId → Viewer-Eintrag
  pending = new Map(); // peerId → Anfrage
  recent = new Map(); // clientId → Zeitpunkt (Auto-Rejoin nach Verbindungsabbruch)
  stream = null;
  controller = null;
  paused = false;
  shareKind = '';
  monitor = null;
  overlayInCapture = false;
  chat = [];
  cursorQueued = false;
  hiddenCursors = new Set(); // clientId/peerId, deren Cursor der Host ausgeblendet hat
  ticks = 0;

  constructor() {
    net.handlers.connection = (c) => this.onConnection(c);
    setInterval(() => this.tick(), 2000);
    onEvent('settings', ({ key }) => this.onSetting(key));
  }

  get sharing() {
    return !!this.stream;
  }

  // --- Verbindungen --------------------------------------------------------
  onConnection(conn) {
    conn.on('data', (m) => this.onData(conn, m));
    conn.on('close', () => this.drop(conn.peer, conn));
    conn.on('error', (e) => log(`Verbindung ${fromPeerId(conn.peer)}: ${e.message}`, 'warn'));
    setTimeout(() => {
      if (!this.viewers.has(conn.peer) && !this.pending.has(conn.peer)) conn.close();
    }, 15_000);
  }

  onData(conn, m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hello') return this.onHello(conn, m);
    const v = this.viewers.get(conn.peer);
    if (!v || v.conn !== conn) return;
    v.lastSeen = Date.now();
    switch (m.t) {
      case 'ping':
        conn.send({ t: 'pong', ts: m.ts });
        if (typeof m.rtt === 'number') v.rtt = Math.round(m.rtt);
        break;
      case 'c':
        v.cursor = unit(m.x) && unit(m.y) ? { x: m.x, y: m.y } : null;
        this.queueCursors();
        break;
      case 'i':
        if (this.controller !== v.id || !Array.isArray(m.e)) break;
        call('input_send', { events: m.e.slice(0, 256) }).catch(() => {});
        break;
      case 'chat': {
        const text = clean(m.text, 1000);
        if (text) this.pushChat({ from: v.id, name: v.name, color: v.color, text });
        break;
      }
      case 'react':
        if (REACTIONS.includes(m.emoji)) this.react({ emoji: m.emoji, name: v.name, color: v.color });
        break;
      case 'req-control':
        this.onControlRequest(v);
        break;
      case 'release-control':
        if (this.controller === v.id) this.setController(null);
        break;
      case 'bye':
        this.drop(v.id, conn);
        conn.close();
        break;
    }
  }

  onHello(conn, m) {
    const req = {
      id: conn.peer,
      code: fromPeerId(conn.peer),
      conn,
      name: clean(m.name, 32) || 'Gast',
      color: isColor(m.color) ? m.color : PALETTE[1],
      clientId: clean(m.clientId, 64),
      at: Date.now(),
    };
    const friend = findFriend(req.code);
    const policy = cfg.settings.joinPolicy;
    const rejoin = req.clientId && Date.now() - (this.recent.get(req.clientId) || 0) < REJOIN_MS;
    if (rejoin || policy === 'auto' || friend?.trusted) return this.accept(req);
    if (policy === 'friends' && !friend) {
      conn.send({ t: 'denied', code: 'friendsOnly' });
      setTimeout(() => conn.close(), 300);
      return;
    }
    conn.send({ t: 'pending' });
    const old = this.pending.get(req.id);
    if (old) clearTimeout(old.timer);
    req.timer = setTimeout(() => this.deny(req.id, 'noAnswer'), 60_000);
    this.pending.set(req.id, req);
    log(`Beitrittsanfrage von ${req.name}`);
    emit('host:request', req);
    emit('host:changed');
  }

  accept(req) {
    const p = this.pending.get(req.id);
    if (p) {
      clearTimeout(p.timer);
      this.pending.delete(req.id);
    }
    const old = this.viewers.get(req.id);
    if (old && old.conn !== req.conn) {
      old.call?.close();
      old.conn.close();
    }
    const used = new Set([cfg.profile.color, ...[...this.viewers.values()].filter((v) => v.id !== req.id).map((v) => v.color)]);
    const color = used.has(req.color) ? PALETTE.find((c) => !used.has(c)) || req.color : req.color;
    const v = { ...req, color, call: null, lastSeen: Date.now(), rtt: null, cursor: null, stats: null, joined: Date.now() };
    delete v.timer;
    this.viewers.set(v.id, v);
    if (v.clientId) this.recent.set(v.clientId, Date.now());
    v.conn.send({
      t: 'welcome',
      host: { name: cfg.profile.name, color: cfg.profile.color },
      color,
      chat: this.chat.slice(-50),
      sharing: this.sharing,
      paused: this.paused,
      overlayInCapture: this.overlayInCapture,
    });
    log(`${v.name} ist beigetreten`);
    emit('host:join', v);
    this.broadcastParticipants();
    if (this.stream) this.callViewer(v);
    else emit('host:need-share');
  }

  /** code: Grund als Schlüssel – der Zuschauer übersetzt ihn in seine Sprache. */
  deny(id, code = 'declined') {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.conn.send({ t: 'denied', code });
    setTimeout(() => p.conn.close(), 300);
    emit('host:changed');
  }

  kick(id) {
    const v = this.viewers.get(id);
    if (!v) return;
    v.conn.send({ t: 'kick' });
    this.recent.delete(v.clientId);
    this.drop(id, v.conn);
    setTimeout(() => v.conn.close(), 300);
  }

  drop(id, conn) {
    const p = this.pending.get(id);
    if (p && p.conn === conn) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      emit('host:changed');
    }
    const v = this.viewers.get(id);
    if (!v || (conn && v.conn !== conn)) return;
    this.viewers.delete(id);
    const c = v.call;
    v.call = null;
    c?.close();
    if (this.controller === id) this.setController(null);
    log(`${v.name} hat die Session verlassen`);
    emit('host:leave', v);
    this.broadcastParticipants();
    this.queueCursors();
  }

  broadcast(msg) {
    for (const v of this.viewers.values()) if (v.conn.open) v.conn.send(msg);
  }

  broadcastParticipants() {
    const list = [...this.viewers.values()].map((v) => ({ id: v.id, name: v.name, color: v.color, ctl: this.controller === v.id, rtt: v.rtt }));
    this.broadcast({ t: 'participants', host: { name: cfg.profile.name, color: cfg.profile.color }, list });
    emit('host:changed');
  }

  // --- Bildschirm teilen ---------------------------------------------------
  async capture() {
    try {
      return await navigator.mediaDevices.getDisplayMedia(captureOptions(cfg.settings));
    } catch (e) {
      log(`Teilen abgebrochen: ${e.message}`, 'warn');
      emit('host:share-error', e);
      return null;
    }
  }

  async startShare() {
    if (this.stream) return true;
    const stream = await this.capture();
    if (!stream) return false;
    await this.setStream(stream);
    for (const v of this.viewers.values()) this.callViewer(v);
    this.broadcast({ t: 'share', sharing: true, paused: false });
    return true;
  }

  async setStream(stream) {
    this.stream = stream;
    this.paused = false;
    const vt = stream.getVideoTracks()[0];
    vt?.addEventListener('ended', () => this.stream === stream && this.stopShare());
    await applyToTrack(vt, cfg.settings);
    await this.detectMonitor();
    log(`Teile ${this.shareKind === 'monitor' ? 'Bildschirm' : 'Fenster'} (${vt?.getSettings().width}×${vt?.getSettings().height})`);
    emit('host:share', true);
  }

  /** Welcher Monitor wird geteilt? Nötig für Maus-Mapping und Cursor-Overlay. */
  async detectMonitor() {
    const s = this.stream?.getVideoTracks()[0]?.getSettings() || {};
    this.shareKind = s.displaySurface || 'monitor';
    const mons = await call('list_monitors').catch(() => []);
    let m = cfg.settings.monitor !== 'auto' ? mons[Number(cfg.settings.monitor)] : null;
    if (!m && s.width) {
      const same = mons.filter((x) => x.rect.w === s.width && x.rect.h === s.height);
      m = same.find((x) => x.primary) || same[0] || mons.find((x) => Math.abs(x.rect.w / x.rect.h - s.width / s.height) < 0.01);
    }
    this.monitor = m || mons.find((x) => x.primary) || mons[0] || null;
    if (this.monitor && this.shareKind === 'monitor') {
      await call('input_target', { rect: this.monitor.rect }).catch(() => {});
      this.overlayInCapture = !!(await call('overlay_show', { rect: this.monitor.rect }).catch(() => false));
    } else {
      await call('overlay_hide').catch(() => {});
      this.overlayInCapture = false;
    }
    this.broadcast({ t: 'overlay', inCapture: this.overlayInCapture });
    this.updateOverlay();
  }

  stopShare() {
    if (!this.stream) return;
    this.setController(null);
    this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.paused = false;
    for (const v of this.viewers.values()) {
      const c = v.call;
      v.call = null;
      c?.close();
    }
    call('overlay_hide').catch(() => {});
    this.broadcast({ t: 'share', sharing: false });
    log('Teilen beendet');
    emit('host:share', false);
  }

  /** Andere Quelle wählen – ohne Neuverbindung, per replaceTrack. */
  async switchSource() {
    if (!this.stream) return this.startShare();
    const next = await this.capture();
    if (!next) return false;
    const old = this.stream;
    this.stream = next;
    for (const v of this.viewers.values()) {
      const senders = v.call?.peerConnection?.getSenders() || [];
      const pairs = next.getTracks().map((t) => [t, senders.find((s) => s.track?.kind === t.kind)]);
      // Neue Spur ohne passenden Sender (z. B. jetzt mit Audio) → neu anrufen
      if (pairs.some(([, s]) => !s)) {
        this.callViewer(v);
        continue;
      }
      await Promise.all(pairs.map(([t, s]) => s.replaceTrack(t))).catch(() => this.callViewer(v));
    }
    old.getTracks().forEach((t) => t.stop());
    await this.setStream(next);
    return true;
  }

  pause(on) {
    if (!this.stream) return;
    this.paused = on;
    this.stream.getTracks().forEach((t) => (t.enabled = !on));
    if (on) this.setController(null);
    this.broadcast({ t: 'share', sharing: true, paused: on });
    this.updateOverlay();
    emit('host:share', true);
  }

  callViewer(v) {
    const old = v.call;
    v.call = null;
    old?.close();
    if (!this.stream || !net.peer) return;
    const codec = cfg.settings.codec;
    const mc = net.peer.call(v.id, this.stream, { metadata: { codec }, sdpTransform: (sdp) => preferCodec(sdp, codec) });
    if (!mc) return;
    v.call = mc;
    const recall = () => {
      if (v.call === mc && this.stream && this.viewers.get(v.id) === v) {
        log(`Medienverbindung zu ${v.name} neu aufbauen …`, 'warn');
        setTimeout(() => v.call === mc && this.callViewer(v), 1500);
      }
    };
    const pc = mc.peerConnection;
    pc?.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected') applyToSender(pc, cfg.settings);
      if (pc.connectionState === 'failed') recall();
    });
    mc.on('close', recall);
    mc.on('error', (e) => log(`Stream zu ${v.name}: ${e.message}`, 'warn'));
  }

  // --- Steuerung -----------------------------------------------------------
  onControlRequest(v) {
    if (this.controller === v.id) return;
    const no = (code) => v.conn.send({ t: 'control', granted: false, code });
    if (!this.stream || this.paused) return no('notSharing');
    if (this.shareKind !== 'monitor') return no('windowShare');
    const policy = cfg.settings.controlPolicy;
    if (policy === 'deny') return no('controlOff');
    if (policy === 'auto') return this.setController(v.id);
    v.conn.send({ t: 'control', pending: true });
    emit('host:control-request', v);
  }

  denyControl(id) {
    this.viewers.get(id)?.conn.send({ t: 'control', granted: false, code: 'controlDeclined' });
  }

  setController(id) {
    const next = id && this.viewers.has(id) ? id : null;
    if (this.controller === next) return;
    const prev = this.viewers.get(this.controller);
    this.controller = next;
    call('input_enable', { enabled: !!next }).catch(() => {});
    prev?.conn.send({ t: 'control', granted: false });
    const v = this.viewers.get(next);
    if (v) {
      v.conn.send({ t: 'control', granted: true });
      log(`${v.name} steuert jetzt`);
    }
    this.broadcastParticipants();
    this.queueCursors();
  }

  // --- Cursor, Chat, Reaktionen -------------------------------------------
  /**
   * Cursor sofort weiterreichen – gebündelt pro Microtask, ohne Timer
   * (Timer werden in Hintergrund-Fenstern gedrosselt und ruckeln dann).
   * Wer steuert, bekommt keinen Farb-Cursor: sein Zeiger ist der echte Mauszeiger.
   */
  queueCursors() {
    if (this.cursorQueued) return;
    this.cursorQueued = true;
    queueMicrotask(() => {
      this.cursorQueued = false;
      const l = this.visibleCursors().map((v) => [v.id, +v.cursor.x.toFixed(4), +v.cursor.y.toFixed(4)]);
      this.broadcast({ t: 'cursors', l, n: cfg.settings.cursorNames });
      this.updateOverlay();
    });
  }

  visibleCursors() {
    if (!cfg.settings.shareCursors) return [];
    return [...this.viewers.values()].filter((v) => v.cursor && v.id !== this.controller && !this.cursorHidden(v));
  }

  cursorHidden(v) {
    return this.hiddenCursors.has(v.clientId || v.id);
  }

  toggleCursor(v) {
    const key = v.clientId || v.id;
    if (!this.hiddenCursors.delete(key)) this.hiddenCursors.add(key);
    this.queueCursors();
    emit('host:changed');
  }

  updateOverlay() {
    if (!this.stream) return;
    const cursors = cfg.settings.remoteCursors
      ? this.visibleCursors().map((v) => ({ id: v.id, name: v.name, color: v.color, x: v.cursor.x, y: v.cursor.y }))
      : [];
    const ctl = this.viewers.get(this.controller);
    emitTo('overlay', 'overlay:state', { cursors, names: cfg.settings.cursorNames, controller: ctl ? { name: ctl.name, color: ctl.color } : null, paused: this.paused });
  }

  pushChat(msg) {
    const full = { id: crypto.randomUUID(), ts: Date.now(), ...msg };
    this.chat.push(full);
    if (this.chat.length > MAX_CHAT) this.chat.shift();
    this.broadcast({ t: 'chat', msg: full });
    emit('host:chat', full);
  }

  sendChat(text) {
    const t = clean(text, 1000);
    if (t) this.pushChat({ from: 'host', name: cfg.profile.name, color: cfg.profile.color, text: t });
  }

  react(r) {
    this.broadcast({ t: 'react', ...r });
    emit('host:react', r);
    emitTo('overlay', 'overlay:react', r);
  }

  hostReact(emoji) {
    if (REACTIONS.includes(emoji)) this.react({ emoji, name: cfg.profile.name, color: cfg.profile.color });
  }

  // --- Wartung -------------------------------------------------------------
  async tick() {
    const now = Date.now();
    for (const v of [...this.viewers.values()]) {
      if (now - v.lastSeen > 20_000) {
        log(`${v.name}: keine Antwort mehr`, 'warn');
        this.drop(v.id, v.conn);
        v.conn.close();
      }
    }
    for (const [id, ts] of this.recent) if (now - ts > REJOIN_MS) this.recent.delete(id);
    if (this.stream) {
      for (const v of this.viewers.values()) v.stats = await readStats(v.call?.peerConnection, 'out', v.stats);
      emit('host:stats');
    }
    if (++this.ticks % 3 === 0 && this.viewers.size) this.broadcastParticipants();
    const n = this.viewers.size;
    call('tray_status', { text: this.stream ? `Screen-Clean – ${window.I18n.t('tray.sharing', { count: n })}` : 'Screen-Clean' }).catch(() => {});
  }

  onSetting(key) {
    const track = this.stream?.getVideoTracks()[0];
    if (['quality', 'manual'].includes(key) && track) {
      applyToTrack(track, cfg.settings);
      for (const v of this.viewers.values()) if (v.call?.peerConnection) applyToSender(v.call.peerConnection, cfg.settings);
    }
    if (key === 'codec' && this.stream) for (const v of this.viewers.values()) this.callViewer(v);
    if (key === 'controlPolicy' && cfg.settings.controlPolicy === 'deny') this.setController(null);
    if (key === 'remoteCursors') this.updateOverlay();
    if (key === 'cursorNames' || key === 'shareCursors') this.queueCursors();
    if (key === 'monitor' && this.stream) this.detectMonitor();
  }

  /** Notbremse (Strg+Shift+X): Steuerung weg, Teilen aus. */
  emergencyStop() {
    this.setController(null);
    this.stopShare();
  }
}

export const host = new Host();
