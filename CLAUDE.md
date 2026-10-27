# YouTube GIF Downloader

Static, backend-free React + Vite page that converts YouTube's animated `.webp` comment GIFs (and other images/videos) to GIF, WebP, APNG, MP4 or WebM in the browser. Deployed to GitHub Pages: https://hamzayslmn.github.io/Youtube-Gif-Downloader/

## Commands (pnpm)

- `pnpm dev`: Vite dev server
- `pnpm test`: `node --test src/*.test.ts` (Node runs TS directly, no test framework)
- `pnpm build`: `tsc --noEmit && vite build` into `dist/`

## Layout

- `src/main.tsx`: the UI
- `src/style.css`: light/dark tokens and the responsive layout, including dual-screen/foldable rules (`env(viewport-segment-* x y)`, indices are column then row)
- `index.html`: SEO head (meta, OG, JSON-LD) and the static, crawlable page content; React only mounts the converter into `#app`
- `src/convert.ts`: target-size mode (`planAt` ladder + sampled-frame estimates + binary search; bitrate fit for video). Also: input sniffing, frame decoding (`ImageDecoder`, mediabunny for video) and the encoders per output format
- `src/gif.worker.ts`: one GIF frame per job (palette, indexing, LZW via gifenc manual mode); `convert.ts` keeps a pool of these and stitches `GIF89a` + frames + trailer
- `src/mux.ts`: hand-written animated WebP (RIFF/ANMF) and APNG containers built from single-frame canvas encodes; covered by `src/mux.test.ts`
- `public/`: copied verbatim into the build (favicon, `sitemap.xml`, Google Search Console verification file `google73d0b5ec95a768e9.html`, which must never be deleted)

## Notes

- `base: "./"` in `vite.config.ts` keeps assets working under the `/Youtube-Gif-Downloader/` project path.
- mediabunny is lazy-loaded only when video is involved; keep it out of the main chunk. `warmUp()` pre-starts the H.264/VP9 encoder when a video format is picked (first start measured ~5.5s).
- Speed claims in README are measured; re-measure before changing them. Don't use `setTimeout` for yielding in the encode loop: background tabs throttle it.
- `.github/FUNDING.yml` drives the repo's Sponsor button.
- Pasted URLs go through the wsrv.nl proxy because `i.ytimg.com` sends no CORS headers.
- `ImageDecoder` needs a secure context (`https://` or `localhost`); Safari lacks it.
- Pushes to `main` run tests + build and deploy via `.github/workflows/pages.yml`.
- Imports use explicit `.ts` extensions (`allowImportingTsExtensions`) so Node's test runner can load them.
