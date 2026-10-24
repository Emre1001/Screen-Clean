// Live-Diagnose aus RTCPeerConnection.getStats().

const ROUTES = { host: 'Direkt (LAN)', srflx: 'Direkt (P2P)', prflx: 'Direkt (P2P)', relay: 'Relay (TURN)' };

/**
 * Liest Video-Stats. `dir` = 'in' (Viewer) oder 'out' (Host).
 * `prev` ist das letzte Ergebnis (für Bitrate aus Byte-Deltas).
 */
export async function readStats(pc, dir, prev) {
  if (!pc || pc.connectionState === 'closed') return null;
  const report = await pc.getStats().catch(() => null);
  if (!report) return null;
  const type = dir === 'in' ? 'inbound-rtp' : 'outbound-rtp';
  const s = { ts: performance.now(), bytes: 0, fps: 0, width: 0, height: 0, codec: '', rtt: null, loss: 0, route: '', encoder: '', limit: '' };
  let pair;
  report.forEach((r) => {
    if (r.type === type && r.kind === 'video') {
      s.bytes = r.bytesReceived ?? r.bytesSent ?? 0;
      s.fps = Math.round(r.framesPerSecond || 0);
      s.width = r.frameWidth || 0;
      s.height = r.frameHeight || 0;
      s.codec = report.get(r.codecId)?.mimeType?.split('/')[1] || '';
      s.encoder = r.encoderImplementation || r.decoderImplementation || '';
      s.limit = r.qualityLimitationReason && r.qualityLimitationReason !== 'none' ? r.qualityLimitationReason : '';
      if (dir === 'in') {
        const total = (r.packetsReceived || 0) + (r.packetsLost || 0);
        s.loss = total ? (100 * (r.packetsLost || 0)) / total : 0;
      }
    }
    if (r.type === 'candidate-pair' && (r.nominated || r.selected) && r.state === 'succeeded') pair = r;
  });
  if (pair) {
    s.rtt = pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null;
    s.route = ROUTES[report.get(pair.localCandidateId)?.candidateType] || '';
  }
  s.kbps = prev && s.bytes >= prev.bytes ? Math.round(((s.bytes - prev.bytes) * 8) / (s.ts - prev.ts)) : 0;
  return s;
}

export const fmtRate = (kbps) => (kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbit/s` : `${kbps} kbit/s`);
