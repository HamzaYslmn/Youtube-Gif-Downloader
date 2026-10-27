import type { GifJob } from "./gif.worker.ts";
import { muxApng, muxWebP, type Frame } from "./mux.ts";

export const FORMATS = {
  gif: { label: "GIF", ext: "gif", mime: "image/gif" },
  webp: { label: "WebP (animated)", ext: "webp", mime: "image/webp" },
  apng: { label: "APNG", ext: "png", mime: "image/png" },
  mp4: { label: "MP4 (H.264)", ext: "mp4", mime: "video/mp4" },
  webm: { label: "WebM (VP9)", ext: "webm", mime: "video/webm" },
} as const;
export type Format = keyof typeof FORMATS;

// A decoded input: frame durations up front, pixels on demand (keeps memory flat for long clips).
type Source = { w: number; h: number; ms: number[]; read(indices: number[]): AsyncGenerator<CanvasImageSource>; close(): void };
// How hard to squeeze. "Original" is scale 1 (or the max width), every frame, full colors / quality.
type Plan = { scale: number; step: number; colors: number; quality: number; bitrate?: number };
type Encoder = { add(ctx: OffscreenCanvasRenderingContext2D, ms: number): unknown; finish(): Promise<Uint8Array> | Uint8Array };
type Progress = (msg: string, frac: number) => void;

const MAX_VIDEO_FPS = 30; // ponytail: fixed cap keeps GIFs sane; expose a control if people ask
const MIN_FPS = 10; // target-size mode never drops below this (or the source rate, if lower)
const SAMPLE_FRAMES = 16; // frames encoded per size estimate

export async function sniff(blob: Blob) {
  const sig = String.fromCharCode(...new Uint8Array(await blob.slice(0, 12).arrayBuffer()));
  const isVideo = blob.type.startsWith("video/") || sig.slice(4, 8) === "ftyp" || sig.startsWith("\x1aE\xdf\xa3");
  const imageType = sig.startsWith("GIF8") ? "image/gif" : sig.startsWith("\x89PNG") ? "image/png" : sig.slice(8, 12) === "WEBP" ? "image/webp" : blob.type;
  return { isVideo, imageType };
}

// ---------- sources ----------

async function openImage(blob: Blob, type: string): Promise<Source> {
  if (!("ImageDecoder" in window)) throw new Error("Your browser lacks ImageDecoder. Use a recent Chrome, Edge or Firefox.");
  const decoder = new ImageDecoder({ data: await blob.arrayBuffer(), type });
  await decoder.tracks.ready;
  await decoder.completed;
  const ms: number[] = [];
  let w = 0, h = 0;
  for (let i = 0; i < decoder.tracks.selectedTrack!.frameCount; i++) {
    const { image } = await decoder.decode({ frameIndex: i });
    ms.push((image.duration ?? 100_000) / 1000);
    if (!i) (w = image.displayWidth), (h = image.displayHeight);
    image.close();
  }
  return {
    w, h, ms,
    async *read(indices) {
      for (const i of indices) {
        const { image } = await decoder.decode({ frameIndex: i });
        yield image;
        image.close();
      }
    },
    close: () => decoder.close(),
  };
}

async function openVideo(blob: Blob): Promise<Source> {
  const mb = await import("mediabunny");
  const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(blob) });
  const track = await input.getPrimaryVideoTrack();
  if (!track || !(await track.canDecode())) throw new Error("This video can't be decoded in your browser.");
  const fps = Math.min(MAX_VIDEO_FPS, (await track.computeFrameRateMetrics()).bestGuessFrameRate || MAX_VIDEO_FPS);
  const start = await track.getFirstTimestamp();
  const end = await track.computeDuration();
  const times = Array.from({ length: Math.max(1, Math.floor((end - start) * fps)) }, (_, i) => start + i / fps);
  const sink = new mb.CanvasSink(track);
  const first = (await sink.getCanvas(start))!.canvas;
  return {
    w: first.width, h: first.height, ms: times.map(() => 1000 / fps),
    async *read(indices) {
      for await (const f of sink.canvasesAtTimestamps(indices.map((i) => times[i]))) if (f) yield f.canvas;
    },
    close: () => input.dispose?.(),
  };
}

// ---------- encoders ----------

async function stillBytes(canvas: OffscreenCanvas, type: string, quality: number) {
  const blob = await canvas.convertToBlob({ type, quality });
  if (blob.type !== type) throw new Error(`Your browser can't encode ${type} images.`);
  return new Uint8Array(await blob.arrayBuffer());
}

// Frames encode in parallel: canvas encodes already run off-thread, GIF frames go to a worker pool.
// Measured on a 128-frame 480×270 clip, 8 in flight: WebP 2.4s → 0.56s, PNG 1.4s → 0.9s.
const PARALLEL = Math.min(8, Math.max(2, navigator.hardwareConcurrency || 4));

function stills(type: string, quality: number, mux: (frames: Frame[]) => Uint8Array, inFlight: number): Encoder {
  const jobs: Promise<Frame>[] = [];
  return {
    async add(ctx, ms) {
      const snap = new OffscreenCanvas(ctx.canvas.width, ctx.canvas.height); // the shared canvas is redrawn next frame
      snap.getContext("2d")!.drawImage(ctx.canvas, 0, 0);
      jobs.push(stillBytes(snap, type, quality).then((b): Frame => [b, ms]));
      if (jobs.length >= inFlight) await jobs[jobs.length - inFlight];
    },
    finish: async () => mux(await Promise.all(jobs)),
  };
}

let gifPool: Worker[] | undefined;
const pending = new Map<number, [(b: Uint8Array) => void, (e: Error) => void]>();
let nextJob = 0;
const gifWorkers = () =>
  (gifPool ??= Array.from({ length: PARALLEL }, () => {
    const w = new Worker(new URL("./gif.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = ({ data }: MessageEvent<{ id: number; bytes: Uint8Array }>) => (pending.get(data.id)![0](data.bytes), pending.delete(data.id));
    w.onerror = (e) => (pending.forEach(([, reject]) => reject(new Error(`GIF encoder failed: ${e.message}`))), pending.clear());
    return w;
  }));

function gifEncoder(colors: number): Encoder {
  const workers = gifWorkers();
  const jobs: Promise<Uint8Array>[] = [];
  return {
    async add(ctx, ms) {
      const { width: w, height: h } = ctx.canvas;
      const rgba = ctx.getImageData(0, 0, w, h).data;
      const id = nextJob++;
      jobs.push(new Promise((resolve, reject) => pending.set(id, [resolve, reject])));
      const job: GifJob = { id, rgba, w, h, colors, delay: ms, first: jobs.length === 1 };
      workers[id % workers.length].postMessage(job, [rgba.buffer]);
      if (jobs.length >= PARALLEL * 2) await jobs[jobs.length - PARALLEL * 2]; // bounds memory: ≤16 frames in flight
    },
    // manual-mode frames: the first carries the screen descriptor + loop block; add the signature and trailer
    finish: async () => new Uint8Array(await new Blob([ascii("GIF89a"), ...(await Promise.all(jobs)), Uint8Array.of(0x3b)] as BlobPart[]).arrayBuffer()),
  };
}

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

async function videoEncoder(canvas: OffscreenCanvas, fmt: "mp4" | "webm", bitrate?: number): Promise<Encoder> {
  const mb = await import("mediabunny");
  const output = new mb.Output({ format: fmt === "mp4" ? new mb.Mp4OutputFormat() : new mb.WebMOutputFormat(), target: new mb.BufferTarget() });
  const codec = fmt === "mp4" ? "avc" : "vp9";
  const source = new mb.CanvasSource(canvas, bitrate ? { codec, bitrate: Math.max(20_000, Math.round(bitrate)) } : { codec, quality: new mb.Quality("high") });
  output.addVideoTrack(source);
  await output.start();
  let t = 0;
  return {
    add: async (_ctx, ms) => (await source.add(t, ms / 1000), (t += ms / 1000)),
    finish: async () => (await output.finalize(), new Uint8Array(output.target.buffer!)),
  };
}

// Measured: the first H.264 encoder in a page takes ~5.5s to start, later ones ~0.6s, and a 2-frame 64×64
// encode pays that start-up cost for every size. So start one as soon as someone picks a video format.
const warmed = new Set<Format>();
export function warmUp(fmt: Format) {
  if (!isVideoFmt(fmt) || warmed.has(fmt)) return;
  warmed.add(fmt);
  const ctx = new OffscreenCanvas(64, 64).getContext("2d")!;
  videoEncoder(ctx.canvas, fmt)
    .then(async (enc) => (await enc.add(ctx, 40), await enc.add(ctx, 40), await enc.finish()))
    .catch(() => {}); // only a speed-up; the real encode reports real errors
}

// Lets the UI paint between frames. Not setTimeout: background tabs throttle that to ≥1s per call.
const yieldToUI = () => new Promise<void>((r) => {
  const { port1, port2 } = new MessageChannel();
  port1.onmessage = () => r();
  port2.postMessage(0);
});

const isVideoFmt = (fmt: Format): fmt is "mp4" | "webm" => fmt === "mp4" || fmt === "webm";

// Drop frames by keeping every `step`-th one; the kept frame absorbs the others' time so playback speed is unchanged.
function keep(ms: number[], step: number) {
  const idx: number[] = [], dur: number[] = [];
  for (let i = 0; i < ms.length; i += step) idx.push(i), dur.push(ms.slice(i, i + step).reduce((a, b) => a + b, 0));
  return { idx, dur };
}

async function encode(src: Source, fmt: Format, plan: Plan, pick?: number[], onFrame?: (done: number, total: number) => void) {
  const { idx, dur } = keep(src.ms, plan.step);
  const sel = pick ?? idx.map((_, k) => k);
  let w = Math.max(1, Math.round(src.w * plan.scale)), h = Math.max(1, Math.round(src.h * plan.scale));
  if (isVideoFmt(fmt)) (w = Math.max(2, w & ~1)), (h = Math.max(2, h & ~1)); // video codecs need even sizes
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: fmt === "gif" })!;
  const enc =
    fmt === "gif" ? gifEncoder(plan.colors)
    : fmt === "webp" ? stills("image/webp", plan.quality, (fr) => muxWebP(fr, w, h), PARALLEL)
    : fmt === "apng" ? stills("image/png", 1, (fr) => muxApng(fr, w, h), 1) // measured: parallel PNG gave no end-to-end gain
    : await videoEncoder(canvas, fmt, plan.bitrate);
  let k = 0;
  for await (const image of src.read(sel.map((j) => idx[j]))) {
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(image, 0, 0, w, h);
    await enc.add(ctx, dur[sel[k]]);
    onFrame?.(++k, sel.length);
    if (k % 4 === 0) await yieldToUI();
  }
  return { bytes: await enc.finish(), w, h, frames: sel.length, kept: idx.length };
}

// ---------- target size ----------

// t = 0 is the original; t = 1 is the most we're willing to squeeze. Each format spends its cheapest-looking savings first.
function planAt(fmt: Format, t: number, base: number, srcFps: number): Plan {
  const ramp = (from: number, to: number) => Math.min(1, Math.max(0, (t - from) / (to - from)));
  const floorFps = Math.min(srcFps, MIN_FPS);
  const step = Math.max(1, Math.round(srcFps / Math.max(floorFps, srcFps * (1 - 0.5 * ramp(0.2, 1)))));
  if (fmt === "webp") return { scale: base * (1 - 0.85 * ramp(0.35, 1)), step, colors: 256, quality: 0.9 - 0.55 * ramp(0, 0.5) };
  if (fmt === "gif") return { scale: base * (1 - 0.85 * t), step, colors: Math.round(256 - 160 * ramp(0.5, 1)), quality: 1 };
  return { scale: base * (1 - 0.85 * t), step, colors: 256, quality: 1 }; // apng: lossless, so only size and frame rate
}

const spread = (n: number, m: number) => Array.from({ length: m }, (_, i) => Math.floor(((i + 0.5) * n) / m));

export type Outcome = { blob: Blob; frames: number; w: number; h: number; missed: boolean };

export async function convert(blob: Blob, fmt: Format, maxWidth: number, targetBytes: number, onProgress: Progress): Promise<Outcome> {
  const { isVideo, imageType } = await sniff(blob);
  if (!isVideo && !imageType.startsWith("image/"))
    throw new Error(`That file isn't an image or video${imageType ? ` (${imageType.split(";")[0]})` : ""}. Use a GIF, WebP, APNG, MP4, WebM or MOV.`);
  onProgress("Reading frames…", 0);
  const src = isVideo ? await openVideo(blob) : await openImage(blob, imageType);
  try {
    const base = maxWidth && src.w > maxWidth ? maxWidth / src.w : 1;
    const totalMs = src.ms.reduce((a, b) => a + b, 0);
    const srcFps = (1000 * src.ms.length) / totalMs;
    const label = `${src.w}×${src.h} → ${FORMATS[fmt].label}`;
    const full = async (plan: Plan, note = "") => {
      const r = await encode(src, fmt, plan, undefined, (d, n) => onProgress(`${note}${label} · frame ${d} / ${n}`, d / n));
      return { ...r, size: r.bytes.length };
    };
    const done = (r: Awaited<ReturnType<typeof full>>, missed = false): Outcome => ({ blob: new Blob([r.bytes as BlobPart], { type: FORMATS[fmt].mime }), frames: r.frames, w: r.w, h: r.h, missed });
    const original: Plan = { scale: base, step: 1, colors: 256, quality: 0.9 };
    if (!targetBytes) return done(await full(original));

    if (isVideoFmt(fmt)) {
      // video: bitrate follows directly from size ÷ duration; shrink the frame only when bits per pixel get too thin to look good
      let bitrate = (targetBytes * 8 * 0.92) / (totalMs / 1000);
      let best, smallest;
      for (let attempt = 1; attempt <= 4; attempt++) {
        const bpp = bitrate / (srcFps * src.w * src.h * base * base);
        const r = await full({ ...original, scale: base * Math.max(0.15, Math.min(1, Math.sqrt(bpp / 0.08))), bitrate }, `Fitting into ${fmtBytes(targetBytes)} (try ${attempt}) · `);
        if (r.size <= targetBytes && (!best || r.size > best.size)) best = r;
        if (!smallest || r.size < smallest.size) smallest = r;
        if (best && best.size >= targetBytes * 0.85) break; // close enough
        // encoders miss short-clip bitrates both ways: steer toward ~95% of the target
        bitrate *= (targetBytes * 0.95) / r.size;
      }
      return best ? done(best) : done(smallest!, true);
    }

    // images: frames are encoded independently, so a handful of sample frames predicts the full size well
    const estimate = async (t: number, plan = planAt(fmt, t, base, srcFps)) => {
      const kept = keep(src.ms, plan.step).idx.length;
      const m = Math.min(kept, SAMPLE_FRAMES);
      const r = await encode(src, fmt, plan, spread(kept, m));
      return (r.bytes.length * kept) / m;
    };
    let pass = 0;
    const probe = (t: number, plan?: Plan) => (onProgress(`Finding the best quality under ${fmtBytes(targetBytes)} (pass ${++pass})…`, Math.min(1, pass / 14)), estimate(t, plan));
    const goal = targetBytes * 0.97; // estimates are within a few %; aim just under
    if ((await probe(0)) <= targetBytes) return done(await full(original));
    let lo = 0, hi = 1;
    if ((await probe(1)) > goal) lo = 1; // can't reach it; settle for the smallest
    else for (let i = 0; i < 7; i++) { const mid = (lo + hi) / 2; (await probe(mid)) <= goal ? (hi = mid) : (lo = mid); }
    let plan = planAt(fmt, lo === 1 ? 1 : hi, base, srcFps);
    // frame-rate and color steps are coarse, so the found plan can land well under budget: spend the rest on resolution
    if (lo !== 1) {
      let a = plan.scale, b = base;
      for (let i = 0; i < 5; i++) { const s = (a + b) / 2; (await probe(0, { ...plan, scale: s })) <= goal ? (a = s) : (b = s); }
      plan = { ...plan, scale: a };
    }
    for (let tries = 1; ; tries++) {
      const r = await full(plan, `Fitting into ${fmtBytes(targetBytes)} · `);
      if (r.size <= targetBytes || lo === 1 || tries === 3) return done(r, r.size > targetBytes);
      plan = { ...plan, scale: plan.scale * Math.sqrt(targetBytes / r.size) * 0.97 }; // overshot: shrink by the measured ratio
    }
  } finally {
    src.close();
  }
}

export const fmtBytes = (b: number) =>
  b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
