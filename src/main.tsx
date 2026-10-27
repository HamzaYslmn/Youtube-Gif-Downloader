import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { convert, fmtBytes, FORMATS, sniff, warmUp, type Format } from "./convert.ts";
import "./style.css";

type Result = { href: string; name: string; fmt: Format; size: number; frames: number; w: number; h: number; missed: boolean; target: number };
const UNITS = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 } as const;
type Unit = keyof typeof UNITS;

const NOT_MEDIA = "That link is a web page, not an image. On YouTube, right-click the GIF → Copy image address, or save the file and drop it here.";

const isThisSite = (url: string) => {
  try {
    const { host, pathname } = new URL(url);
    return host === location.host || (host === "hamzayslmn.github.io" && pathname.toLowerCase().startsWith("/youtube-gif-downloader"));
  } catch {
    return false;
  }
};

// A share link to this site (…?url=<image>) means the image inside it
const unwrapShareLink = (url: string) => (isThisSite(url) && new URL(url).searchParams.get("url")) || url;

// Web pages usually name their main image/video in meta tags (og:image, twitter:image…)
function mediaFromHtml(html: string, base: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const content = ["og:video:url", "og:video", "og:image", "twitter:image"]
    .map((p) => doc.querySelector(`meta[property="${p}"], meta[name="${p}"]`)?.getAttribute("content"))
    .find(Boolean);
  return content ? new URL(content, base).href : undefined;
}

async function download(url: string, depth = 0): Promise<Blob> {
  // i.ytimg.com sends no CORS headers, so YouTube (and any other blocked image) goes through the wsrv.nl proxy
  if (!/\.ytimg\.com\//.test(url)) {
    let blob: Blob | undefined;
    try {
      const r = await fetch(url);
      if (r.ok) blob = await r.blob();
    } catch {}
    if (blob && !blob.type.startsWith("text/html")) return blob;
    if (blob) {
      const media = depth === 0 && mediaFromHtml(await blob.text(), url); // text() decodes UTF-8
      if (media) return download(media, 1);
      throw new Error(NOT_MEDIA);
    }
  }
  const r = await fetch("https://wsrv.nl/?n=-1&output=webp&url=" + encodeURIComponent(url));
  // wsrv answers 4xx when the link isn't an image (most often a page URL)
  if (!r.ok) throw new Error(r.status >= 400 && r.status < 500 ? NOT_MEDIA : `Couldn't download that link (HTTP ${r.status}). Save the file and drop it here instead.`);
  return r.blob();
}

// Keeps Unicode names (ç, ş, ğ, ü, 日本…) and replaces only characters file systems reject
const baseName = (s: string) => {
  let last = s.split(/[?#]/)[0].split("/").filter(Boolean).at(-1) ?? "";
  try {
    last = decodeURIComponent(last); // %C3%A7 → ç
  } catch {}
  return last.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim().slice(0, 80) || "converted";
};

// YouTube URLs end in "…_webp_animated….webp"; the comment id one level up is the useful name
const nameFromUrl = (url: string) => (/ytimg\.com\/c_exp\//.test(url) ? baseName(url.split("/").slice(0, -1).join("/")) : baseName(url));

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const UPLOAD = "M12 16V4m0 0-4 4m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2";
const DOWNLOAD = "M12 4v12m0 0-4-4m4 4 4-4M4 20h16";
const CLIPBOARD = "M9 4h6v3H9zM7 5H5v15h14V5h-2";

function App() {
  const [url, setUrl] = useState("");
  const [fmt, setFmt] = useState<Format | "auto">("auto");
  const [maxWidth, setMaxWidth] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ msg: string; err?: boolean }>({ msg: "" });
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<Result>();
  const [over, setOver] = useState(false);
  const [sizeMode, setSizeMode] = useState<"original" | "target">("original");
  const [targetValue, setTargetValue] = useState(8);
  const [unit, setUnit] = useState<Unit>("MB");
  const targetBytes = sizeMode === "target" && targetValue > 0 ? Math.round(targetValue * UNITS[unit]) : 0;
  const settings = useRef({ fmt, maxWidth, targetBytes });
  settings.current = { fmt, maxWidth, targetBytes };
  const preview = useRef<HTMLDivElement>(null);

  useEffect(() => () => void (result && URL.revokeObjectURL(result.href)), [result]);
  useEffect(() => void (fmt !== "auto" && warmUp(fmt)), [fmt]);

  async function run(getBlob: () => Promise<Blob>, name: string) {
    setBusy(true);
    setResult(undefined);
    setProgress(0);
    // on stacked layouts (phones) the preview sits below the inputs
    preview.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    try {
      setStatus({ msg: "Downloading…" });
      const blob = await getBlob();
      const { imageType } = await sniff(blob);
      const { fmt, maxWidth, targetBytes } = settings.current;
      const target = fmt === "auto" ? (imageType === "image/gif" ? "webp" : "gif") : fmt;
      const out = await convert(blob, target, maxWidth, targetBytes, (msg, frac) => {
        setProgress(frac);
        setStatus({ msg });
      });
      setResult({ href: URL.createObjectURL(out.blob), name: `${name}.${FORMATS[target].ext}`, fmt: target, size: out.blob.size, frames: out.frames, w: out.w, h: out.h, missed: out.missed, target: targetBytes });
      setStatus({ msg: "" });
    } catch (e) {
      setStatus({ msg: (e as Error).message, err: true });
    } finally {
      setBusy(false);
    }
  }

  function runUrl(raw: string) {
    const u = unwrapShareLink(raw.trim());
    if (!/^https?:\/\//i.test(u)) return setStatus({ msg: "Please paste an http(s) link.", err: true });
    if (isThisSite(u)) return setStatus({ msg: "That's this site's own address. Paste the GIF's image address instead (right-click the GIF → Copy image address).", err: true });
    setUrl(u);
    run(() => download(u), nameFromUrl(u));
  }
  const runFile = (f?: File) => f && run(async () => f, baseName(f.name));

  async function pasteUrl() {
    try {
      runUrl(await navigator.clipboard.readText());
    } catch {
      setStatus({ msg: "Clipboard access was blocked. Long-press the field and paste instead.", err: true });
    }
  }

  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const to = q.get("to");
    if (to && to in FORMATS) setFmt((settings.current.fmt = to as Format));
    if (q.get("url")) runUrl(q.get("url")!);
    const onPaste = (e: ClipboardEvent) => {
      const f = e.clipboardData?.files[0];
      if (f && !(e.target instanceof HTMLInputElement)) runFile(f);
    };
    addEventListener("paste", onPaste);
    return () => removeEventListener("paste", onPaste);
  }, []);

  const isVideo = result && (result.fmt === "mp4" || result.fmt === "webm");
  return (
    <section className="card" aria-label="Converter">
      <div className="pane">
        <form className="url" onSubmit={(e) => (e.preventDefault(), runUrl(url))}>
          <input type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Paste a YouTube GIF link…" aria-label="Image or video URL" required />
          <button type="button" className="ghost icon-btn" onClick={pasteUrl} disabled={busy} title="Paste from clipboard" aria-label="Paste from clipboard"><Icon d={CLIPBOARD} /></button>
          <button type="submit" className="primary" disabled={busy}>Convert</button>
        </form>

        <label
          className={"drop" + (over ? " over" : "")}
          onDragOver={(e) => (e.preventDefault(), setOver(true))}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const f = e.dataTransfer.files[0];
            const u = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
            f ? runFile(f) : u && runUrl(u);
          }}
        >
          <input type="file" accept="image/*,video/*" className="sr-only" onChange={(e) => runFile(e.target.files?.[0])} disabled={busy} />
          <span className="drop-icon"><Icon d={UPLOAD} /></span>
          <span><b>Choose a file</b> or drop it here</span>
          <small>GIF · WebP · APNG · MP4 · WebM · MOV</small>
        </label>

        <fieldset className="chips">
          <legend>Convert to</legend>
          {(["auto", ...Object.keys(FORMATS)] as const).map((k) => (
            <label key={k} className="chip">
              <input type="radio" name="fmt" value={k} checked={fmt === k} onChange={() => setFmt(k as Format | "auto")} />
              <span>{k === "auto" ? "Auto" : FORMATS[k as Format].label.split(" ")[0]}</span>
            </label>
          ))}
        </fieldset>
        <p className="hint">{fmt === "auto" ? "Auto makes a GIF, or a WebP if the source is already a GIF." : FORMATS[fmt].label}</p>

        <div className="fields">
          <label className="field">
            <span>Max width</span>
            <select value={maxWidth} onChange={(e) => setMaxWidth(+e.target.value)}>
              <option value={0}>Same as source</option>
              {[1080, 720, 480, 320].map((w) => <option key={w} value={w}>{w} px</option>)}
            </select>
          </label>

          <fieldset className="field">
            <legend>File size</legend>
            <div className="segmented">
              {(["original", "target"] as const).map((m) => (
                <label key={m}>
                  <input type="radio" name="size" checked={sizeMode === m} onChange={() => setSizeMode(m)} />
                  <span>{m === "original" ? "Original quality" : "Target size"}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        {sizeMode === "target" && (
          <div className="target">
            <input type="number" inputMode="decimal" min="0.01" step="any" value={targetValue || ""} onChange={(e) => setTargetValue(+e.target.value)} aria-label="Target file size" />
            <select value={unit} onChange={(e) => setUnit(e.target.value as Unit)} aria-label="Unit">
              {Object.keys(UNITS).map((u) => <option key={u}>{u}</option>)}
            </select>
            <p className="hint">Keeps as much quality as possible: lowers quality, frame rate and size only as far as needed to get under {targetBytes ? fmtBytes(targetBytes) : "the target"}.</p>
          </div>
        )}
      </div>

      <div className={"pane preview" + (result ? " has-result" : "")} ref={preview} aria-live="polite">
        {result ? (
          <>
            <div className="stage">
              {isVideo ? <video src={result.href} autoPlay loop muted playsInline controls /> : <img src={result.href} alt="Converted animation" />}
            </div>
            <ul className="meta">
              <li>{FORMATS[result.fmt].label.split(" ")[0]}</li>
              <li>{result.w}×{result.h}</li>
              <li>{result.frames} frames</li>
              <li className={result.target ? (result.missed ? "over" : "fit") : ""}>{fmtBytes(result.size)}{result.target > 0 && !result.missed && ` ≤ ${fmtBytes(result.target)}`}</li>
            </ul>
            {result.missed && <p className="error">Couldn't get under {fmtBytes(result.target)} without wrecking it. This is the smallest version. Try a smaller max width or WebP/MP4.</p>}
            <a className="primary download" href={result.href} download={result.name}><Icon d={DOWNLOAD} /> Download {result.name.split(".").pop()!.toUpperCase()}</a>
          </>
        ) : busy ? (
          <div className="working">
            <div className="spinner" aria-hidden="true" />
            <div className="bar"><span style={{ width: `${progress * 100}%` }} /></div>
            <p>{status.msg}</p>
          </div>
        ) : (
          <div className="empty">
            <span className="empty-art" aria-hidden="true">GIF</span>
            <p>Your converted animation shows up here.</p>
          </div>
        )}
        {status.err && <p className="error" role="alert">{status.msg}</p>}
      </div>
    </section>
  );
}

createRoot(document.getElementById("app")!).render(<App />); // no StrictMode: its double effects would run ?url= twice in dev
