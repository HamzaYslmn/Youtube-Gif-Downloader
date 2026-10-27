import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { muxApng, muxWebP } from "./mux.ts";

const ids = (b: Uint8Array, start: number, le: boolean) => {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: string[] = [];
  for (let p = start; p + 8 <= b.length; ) {
    const len = dv.getUint32(le ? p + 4 : p, le);
    out.push(Buffer.from(b.subarray(le ? p : p + 4, le ? p + 4 : p + 8)).toString("latin1"));
    p += le ? 8 + len + (len & 1) : 12 + len;
  }
  return out;
};

test("animated WebP wraps each still frame in ANMF", () => {
  const still = (id: string) => new Uint8Array([...Buffer.from("RIFF\0\0\0\0WEBP" + id), 3, 0, 0, 0, 1, 2, 3, 0]);
  const out = muxWebP([[still("VP8L"), 100], [still("VP8 "), 40]], 2, 2);
  assert.equal(Buffer.from(out.subarray(8, 12)).toString(), "WEBP");
  assert.equal(new DataView(out.buffer).getUint32(4, true), out.length - 8);
  assert.deepEqual(ids(out, 12, true), ["VP8X", "ANIM", "ANMF", "ANMF"]);
});

test("APNG keeps one IHDR and numbers fcTL/fdAT in sequence", () => {
  const png = (shade: number) => {
    const chunk = (t: string, d: Buffer) => {
      const b = Buffer.alloc(12 + d.length);
      b.writeUInt32BE(d.length);
      b.write(t, 4, "latin1");
      d.copy(b, 8);
      return b; // the muxer ignores input CRCs
    };
    const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
    return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from([0, shade, shade, shade, 255]))), chunk("IEND", Buffer.alloc(0))]));
  };
  const out = muxApng([[png(0), 100], [png(255), 100], [png(128), 50]], 1, 1);
  assert.deepEqual(ids(out, 8, false), ["IHDR", "acTL", "fcTL", "IDAT", "fcTL", "fdAT", "fcTL", "fdAT", "IEND"]);
  const dv = new DataView(out.buffer);
  const seqs = [];
  for (let p = 8; p < out.length; p += 12 + dv.getUint32(p)) if (/fcTL|fdAT/.test(Buffer.from(out.subarray(p + 4, p + 8)).toString())) seqs.push(dv.getUint32(p + 8));
  assert.deepEqual(seqs, [0, 1, 2, 3, 4]);
});
