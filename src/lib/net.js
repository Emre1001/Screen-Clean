// PeerJS-Verbindung zum Signaling-Server mit stabilem Code + Auto-Reconnect.
import { Peer } from 'peerjs';
import { cfg, emit, log, save } from './store.js';

const PREFIX = 'screenclean-';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 Zeichen, ohne I/O/0/1

export const toPeerId = (code) => PREFIX + code.toLowerCase();
export const fromPeerId = (id) => (id?.startsWith(PREFIX) ? id.slice(PREFIX.length).toUpperCase() : '');
export const fmtCode = (c) => (c?.length === 6 ? `${c.slice(0, 3)}-${c.slice(3)}` : c || '');

export function newCode() {
  return [...crypto.getRandomValues(new Uint8Array(6))].map((b) => ALPHABET[b % 32]).join('');
}

/** Nutzereingabe → Code oder '' wenn ungültig. */
export function parseCode(input) {
  const c = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === 6 && [...c].every((ch) => ALPHABET.includes(ch)) ? c : '';
}

function peerOptions() {
  const opts = { debug: 0 };
  const url = cfg.settings.signaling?.trim();
  if (url) {
    try {
      const u = new URL(url);
      Object.assign(opts, {
        host: u.hostname,
        port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname || '/',
        secure: u.protocol === 'https:',
      });
    } catch {
      log(`Ungültige Signaling-URL: ${url}`, 'error');
    }
  }
  return opts;
}

/** Zustände: offline | connecting | online | busy | error */
class Net {
  peer = null;
  state = 'offline';
  error = '';
  retries = 0;
  timer = null;
  handlers = { connection: () => {}, call: () => {}, peerUnavailable: () => {} };

  get id() {
    return toPeerId(cfg.code);
  }

  setState(state, error = '') {
    this.state = state;
    this.error = error;
    emit('net', { state, error });
  }

  start() {
    if (!cfg.code) {
      cfg.code = newCode();
      save();
    }
    clearTimeout(this.timer);
    this.peer?.destroy();
    this.setState('connecting');
    const p = new Peer(this.id, peerOptions());
    this.peer = p;
    p.on('open', () => {
      this.retries = 0;
      this.setState('online');
      log(`Online als ${fmtCode(cfg.code)}`);
    });
    p.on('connection', (c) => this.handlers.connection(c));
    p.on('call', (c) => this.handlers.call(c));
    p.on('disconnected', () => {
      if (p !== this.peer || p.destroyed) return;
      log('Signaling getrennt – verbinde neu …', 'warn');
      this.setState('connecting');
      this.timer = setTimeout(() => !p.destroyed && p.reconnect(), this.backoff());
    });
    p.on('error', (err) => this.onError(p, err));
  }

  backoff() {
    const ms = Math.min(30_000, 1000 * 2 ** this.retries++) + Math.random() * 500;
    return Math.round(ms);
  }

  onError(p, err) {
    if (p !== this.peer) return;
    log(`Peer-Fehler (${err.type}): ${err.message}`, err.type === 'peer-unavailable' ? 'warn' : 'error');
    switch (err.type) {
      case 'peer-unavailable':
        this.handlers.peerUnavailable(err);
        return;
      case 'unavailable-id':
        // Alte Sitzung hält den Code noch (z. B. nach Absturz) – Server gibt ihn bald frei.
        this.setState('busy', 'Dein Code ist noch belegt – neuer Versuch …');
        break;
      case 'browser-incompatible':
        this.setState('error', 'WebRTC wird von diesem WebView nicht unterstützt.');
        return;
      case 'invalid-id':
        cfg.code = newCode();
        save();
        break;
      case 'network':
      case 'server-error':
      case 'socket-error':
      case 'socket-closed':
        this.setState('connecting', 'Signaling-Server nicht erreichbar');
        break;
      default:
        return; // Verbindungsfehler einzelner Peers betreffen das Netz nicht
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.start(), this.backoff());
  }

  /** Neuen Code erzeugen (z. B. wenn der alte dauerhaft belegt ist). */
  regenerate() {
    cfg.code = newCode();
    save();
    this.retries = 0;
    this.start();
    emit('code');
  }
}

export const net = new Net();
