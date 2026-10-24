// Video-Qualität: Presets, Capture-Constraints, Sender-Parameter, Codec-Wahl.

export const PRESETS = {
  auto: { label: 'Auto', desc: 'WebRTC regelt selbst – bis 60 FPS', fps: 60, height: 0, bitrate: 12, pref: '', hint: '' },
  gaming: { label: 'Gaming', desc: 'Bis 120 FPS, 1080p, flüssig vor scharf', fps: 120, height: 1080, bitrate: 25, pref: 'maintain-framerate', hint: 'motion' },
  text: { label: 'Arbeit & Text', desc: 'Gestochen scharf, 30 FPS', fps: 30, height: 0, bitrate: 8, pref: 'maintain-resolution', hint: 'text' },
  saver: { label: 'Laptop-Modus', desc: '720p, 30 FPS – schont Akku & Leitung', fps: 30, height: 720, bitrate: 3, pref: 'balanced', hint: 'detail' },
};

export const CODECS = ['H264', 'VP8', 'VP9', 'AV1'];

export function qualityFor(settings) {
  if (settings.quality === 'manual') {
    const m = settings.manual;
    return { fps: m.fps, height: m.height, bitrate: m.bitrate, pref: '', hint: '' };
  }
  return PRESETS[settings.quality] || PRESETS.auto;
}

export function captureOptions(settings) {
  const q = qualityFor(settings);
  return {
    video: { frameRate: { ideal: q.fps, max: q.fps }, cursor: 'always' },
    audio: settings.audio
      ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false }
      : false,
    systemAudio: settings.audio ? 'include' : 'exclude',
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    monitorTypeSurfaces: 'include',
  };
}

export async function applyToTrack(track, settings) {
  if (!track) return;
  const q = qualityFor(settings);
  track.contentHint = q.hint;
  await track.applyConstraints({ frameRate: { ideal: q.fps, max: q.fps } }).catch(() => {});
}

/** Bitrate/FPS/Skalierung live auf alle Video-Sender einer Verbindung anwenden. */
export async function applyToSender(pc, settings) {
  const q = qualityFor(settings);
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== 'video') continue;
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    const srcH = sender.track.getSettings().height || 0;
    const enc = params.encodings[0];
    enc.maxBitrate = q.bitrate * 1_000_000;
    enc.maxFramerate = q.fps;
    enc.scaleResolutionDownBy = q.height && srcH > q.height ? srcH / q.height : 1;
    // leer = Browser-Standard (bei Bildschirm: Auflösung halten, Text bleibt scharf)
    if (q.pref) params.degradationPreference = q.pref;
    await sender.setParameters(params).catch(() => {});
  }
}

/** Welche Codecs kann dieses WebView senden? */
export function availableCodecs() {
  const caps = globalThis.RTCRtpSender?.getCapabilities?.('video')?.codecs || [];
  const names = new Set(caps.map((c) => c.mimeType.split('/')[1].toUpperCase()));
  return CODECS.filter((c) => names.has(c));
}

/** SDP-Munging: Payload-Types des Wunsch-Codecs (+ RTX) in m=video nach vorn. */
export function preferCodec(sdp, codec) {
  if (!sdp || !codec || codec === 'auto') return sdp;
  const lines = sdp.split('\r\n');
  const mi = lines.findIndex((l) => l.startsWith('m=video'));
  if (mi < 0) return sdp;
  let end = lines.findIndex((l, i) => i > mi && l.startsWith('m='));
  if (end < 0) end = lines.length;
  const section = lines.slice(mi, end);
  const names = {};
  for (const l of section) {
    const m = l.match(/^a=rtpmap:(\d+) ([\w-]+)\//);
    if (m) names[m[1]] = m[2].toUpperCase();
  }
  const wanted = Object.keys(names).filter((pt) => names[pt] === codec.toUpperCase());
  if (!wanted.length) return sdp;
  const rtx = [];
  for (const l of section) {
    const m = l.match(/^a=fmtp:(\d+) apt=(\d+)/);
    if (m && wanted.includes(m[2])) rtx.push(m[1]);
  }
  const parts = lines[mi].split(' ');
  const pts = parts.slice(3);
  const first = [...wanted, ...rtx].filter((p) => pts.includes(p));
  lines[mi] = [...parts.slice(0, 3), ...first, ...pts.filter((p) => !first.includes(p))].join(' ');
  return lines.join('\r\n');
}
