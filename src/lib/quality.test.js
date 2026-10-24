// node --test src/lib
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preferCodec, qualityFor } from './quality.js';

const SDP = [
  'v=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=rtpmap:111 opus/48000/2',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 97 102 103 45',
  'a=rtpmap:96 VP8/90000',
  'a=rtpmap:97 rtx/90000',
  'a=fmtp:97 apt=96',
  'a=rtpmap:102 H264/90000',
  'a=rtpmap:103 rtx/90000',
  'a=fmtp:103 apt=102',
  'a=rtpmap:45 AV1/90000',
  '',
].join('\r\n');

test('preferCodec moves codec + rtx to front of m=video', () => {
  const out = preferCodec(SDP, 'H264');
  assert.match(out, /m=video 9 UDP\/TLS\/RTP\/SAVPF 102 103 96 97 45\r\n/);
  assert.match(out, /m=audio 9 UDP\/TLS\/RTP\/SAVPF 111\r\n/);
});

test('preferCodec leaves sdp alone for auto / unknown codec', () => {
  assert.equal(preferCodec(SDP, 'auto'), SDP);
  assert.equal(preferCodec(SDP, 'VP9'), SDP);
});

test('qualityFor manual uses manual values', () => {
  const q = qualityFor({ quality: 'manual', manual: { fps: 144, height: 1440, bitrate: 40 } });
  assert.equal(q.fps, 144);
  assert.equal(q.bitrate, 40);
  assert.equal(qualityFor({ quality: 'nope' }).fps, 60);
});
