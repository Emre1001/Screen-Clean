// Geräte im lokalen Netz (UDP-Beacons aus Rust) + eigener Beacon.
import { call, on } from './bridge.js';
import { host } from './host.js';
import { net, parseCode } from './net.js';
import { cfg, emit, onEvent } from './store.js';

export const lan = new Map(); // code → { code, name, ip, sharing, os, seen }

on('lan:peer', (p) => {
  const code = parseCode(p.id);
  if (!code || code === cfg.code) return;
  if (p.bye) lan.delete(code);
  else lan.set(code, { code, name: String(p.name || code).slice(0, 32), ip: p.ip, sharing: !!p.sharing, os: p.os, seen: Date.now() });
  emit('lan');
});

setInterval(() => {
  let changed = false;
  for (const [code, p] of lan) if (Date.now() - p.seen > 7000) changed = lan.delete(code);
  if (changed) emit('lan');
}, 2000);

export function updateBeacon() {
  const visible = cfg.settings.lanVisible && net.state === 'online';
  call('discovery_set', { beacon: visible ? { v: 1, id: cfg.code, name: cfg.profile.name, sharing: host.sharing, os: navigator.platform } : null }).catch(() => {});
}

onEvent('net', updateBeacon);
onEvent('profile', updateBeacon);
onEvent('host:share', updateBeacon);
onEvent('code', updateBeacon);
onEvent('settings', ({ key }) => key === 'lanVisible' && updateBeacon());
