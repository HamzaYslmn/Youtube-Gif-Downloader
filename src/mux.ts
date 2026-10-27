// Containers for animated WebP and APNG, built from single-frame files the browser's canvas encoder made.
// A frame is [encoded still image bytes, duration in ms].
export type Frame = [Uint8Array, number];

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const text = (b: Uint8Array) => String.fromCharCode(...b);
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((o, p) => (out.set(p, o), o + p.length), 0);
  return out;
};

// ---- WebP (RIFF, little-endian, chunks padded to even length) ----

function riffChunks(b: Uint8Array) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: [string, Uint8Array][] = [];
  for (let p = 12; p + 8 <= b.length; ) {
    const len = dv.getUint32(p + 4, true);
    out.push([text(b.subarray(p, p + 4)), b.subarray(p + 8, p + 8 + len)]);
    p += 8 + len + (len & 1);
  }
  return out;
}

function riffChunk(id: string, data: Uint8Array) {
  const out = new Uint8Array(8 + data.length + (data.length & 1));
  out.set(ascii(id));
  new DataView(out.buffer).setUint32(4, data.length, true);
  out.set(data, 8);
  return out;
}

const u24 = (b: Uint8Array, o: number, v: number) => b.set([v & 255, (v >> 8) & 255, (v >> 16) & 255], o);

export function muxWebP(frames: Frame[], w: number, h: number) {
  const vp8x = new Uint8Array(10);
  vp8x[0] = 0x12; // animation + alpha
  u24(vp8x, 4, w - 1);
  u24(vp8x, 7, h - 1);
  const parts = [riffChunk("VP8X", vp8x), riffChunk("ANIM", new Uint8Array(6))]; // transparent bg, loop forever
  for (const [bytes, ms] of frames) {
    const anmf = new Uint8Array(16); // x=0, y=0
    u24(anmf, 6, w - 1);
    u24(anmf, 9, h - 1);
    u24(anmf, 12, Math.round(ms));
    anmf[15] = 0b10; // don't blend: every frame is a full frame
    const image = riffChunks(bytes).filter(([id]) => id === "ALPH" || id === "VP8 " || id === "VP8L");
    parts.push(riffChunk("ANMF", concat([anmf, ...image.map(([id, d]) => riffChunk(id, d))])));
  }
  return riffChunk("RIFF", concat([ascii("WEBP"), ...parts]));
}

// ---- APNG (big-endian, CRC per chunk) ----

const CRC = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
const crc32 = (b: Uint8Array) => (b.reduce((c, x) => CRC[(c ^ x) & 255] ^ (c >>> 8), ~0) ^ ~0) >>> 0;

function pngChunks(b: Uint8Array) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: [string, Uint8Array][] = [];
  for (let p = 8; p + 12 <= b.length; ) {
    const len = dv.getUint32(p);
    out.push([text(b.subarray(p + 4, p + 8)), b.subarray(p + 8, p + 8 + len)]);
    p += 12 + len;
  }
  return out;
}

function pngChunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(ascii(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const be = (...fields: [number, 1 | 2 | 4][]) => {
  const out = new Uint8Array(fields.reduce((n, [, size]) => n + size, 0));
  const dv = new DataView(out.buffer);
  fields.reduce((o, [v, size]) => (size === 4 ? dv.setUint32(o, v) : size === 2 ? dv.setUint16(o, v) : dv.setUint8(o, v), o + size), 0);
  return out;
};

export function muxApng(frames: Frame[], w: number, h: number) {
  const ihdr = pngChunks(frames[0][0]).find(([t]) => t === "IHDR")![1];
  const parts = [Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), pngChunk("IHDR", ihdr), pngChunk("acTL", be([frames.length, 4], [0, 4]))];
  let seq = 0;
  frames.forEach(([bytes, ms], i) => {
    const chunks = pngChunks(bytes);
    // all frames must share the first frame's pixel format, since only the first IHDR is kept
    if (text(chunks.find(([t]) => t === "IHDR")![1]) !== text(ihdr)) throw new Error("APNG frames have mismatched formats.");
    parts.push(pngChunk("fcTL", be([seq++, 4], [w, 4], [h, 4], [0, 4], [0, 4], [Math.min(65535, Math.round(ms)), 2], [1000, 2], [0, 1], [0, 1])));
    for (const [t, d] of chunks) {
      if (t !== "IDAT") continue;
      parts.push(i === 0 ? pngChunk("IDAT", d) : pngChunk("fdAT", concat([be([seq++, 4]), d])));
    }
  });
  parts.push(pngChunk("IEND", new Uint8Array()));
  return concat(parts);
}
