// Encodes one GIF frame (palette + indexing + LZW) off the main thread.
// Frames are independent, so a pool of these runs them in parallel; convert.ts stitches the bytes together.
import { GIFEncoder, quantize, applyPalette } from "gifenc";

export type GifJob = { id: number; rgba: Uint8ClampedArray; w: number; h: number; colors: number; delay: number; first: boolean };

const everyNth = (rgba: Uint8ClampedArray, n: number) => {
  const out = new Uint8ClampedArray(Math.floor(rgba.length / 4 / n) * 4);
  for (let i = 0; i < out.length; i += 4) out.set(rgba.subarray(i * n, i * n + 4), i);
  return out;
};

const scope = self as unknown as Worker;
scope.onmessage = ({ data: { id, rgba, w, h, colors, delay, first } }: MessageEvent<GifJob>) => {
  // rgba4444 is needed for transparency but bands colors; opaque frames get the finer rgb565
  let opaque = true;
  for (let i = 3; i < rgba.length && opaque; i += 4) opaque = rgba[i] === 255;
  const format = opaque ? "rgb565" : "rgba4444";
  // measured: building the palette from every 8th pixel halves rgb565 time for −0.1 dB PSNR.
  // Opaque only, since a sparse sample could miss the few transparent pixels.
  const palette = quantize(opaque ? everyNth(rgba, 8) : rgba, colors, { format, oneBitAlpha: true });
  const transparentIndex = opaque ? -1 : palette.findIndex((c) => c[3] === 0);
  const enc = GIFEncoder({ auto: false });
  // browsers slow down GIF delays under 20ms, so clamp
  enc.writeFrame(applyPalette(rgba, palette, format), w, h, { palette, delay: Math.max(20, delay), transparent: transparentIndex >= 0, transparentIndex, first, repeat: 0 });
  const bytes = enc.bytes();
  scope.postMessage({ id, bytes }, [bytes.buffer]);
};
