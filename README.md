# Tessel

**Every document, in its place.** A calm PDF viewer: no ads, no account, files stay on your device. Native-first (iOS, Android) with a first-class web build from one Expo codebase.

Live web app: https://jibes.github.io/doc-reader/

## Principles

1. **Viewer first, reading when you want it.** Documents open in a plain viewer with a toolbar that's always there. Add a document to the reading list and it opens with reading behaviour: toolbars step aside as you read forward, and progress is shown.
2. **Always back where you left off.** Every document remembers its position; bookmarks mark pages.
3. **Order, not overwhelm.** One home screen: Reading list on top, Recent below. No ads, no upsells, no accounts.
4. **Performance before size.** Each platform's best PDF engine, rendering off the main thread, scheduled by distance from the page you're on.

## Scope (MECE)

| Domain | Shipped | Next |
|---|---|---|
| Home — acquire, organise, resume | Open/picker, drag-and-drop, OS "Open with" (PWA File Handling), Recent list, reading list with progress + Finished, filter, remove (keeps the original) | Open in place without copying |
| Viewer — render, navigate, find | Virtualised continuous scroll, fit width/page, zoom (buttons, ⌘±, trackpad/pinch), outline, page grid, scrubber with chapter marks, go-to-page, full-text search with persistent highlights and find bar | Text selection, links, password prompt, share/print |
| Reading | Reading list, immersive chrome, progress, bookmarks | Reflowed text view (phase 3) |
| Personalisation | Light, Sepia, Dark, Black, Auto; English and German (follows OS) | More languages |
| Platform | Offline PWA, install button, IndexedDB / app-documents storage, keyboard map, a11y labels | EAS builds |

## Architecture

```
src/app/            routes (expo-router): library, read/[id]
src/reader/         reading surface: layout math, raster cache + scheduler, scrubber, panels
src/components/     shared UI primitives, covers, empty state, drop zone
src/design/         tokens: palettes, type scale, spacing, motion
src/state/          zustand stores: library, prefs
src/storage/        persistence port — index.web.ts (IndexedDB) | index.ts (expo-file-system)
src/engine/         DocumentEngine contract (types.ts)
  index.web.ts        → PDFium WASM in a Web Worker (src/engine/pdfium/worker.ts)
  index.ts            → native module modules/pdf-engine
modules/pdf-engine/ local Expo module — iOS: PDFKit (Swift), Android: PdfRenderer (Kotlin)
```

UI depends only on `src/engine/types.ts`. Platform files (`*.web.ts`) pick the implementation at bundle time.

**Render pipeline.** `RasterCache` de-duplicates requests, refcounts cancellation, keeps ≤ 2 renders in flight and always starts the page closest to the reading position. Web rasters are `ImageBitmap`s transferred from the worker and drawn to `<canvas>`; theme tint is a GPU CSS filter, so switching theme never re-renders. Native rasters are cached JPEG files tinted with a blend-mode overlay.

## Commands

```bash
npm install            # also builds the PDFium worker into public/engine
npm run web            # dev server (http://localhost:8081)
npm run ios|android    # dev build (needs Xcode / Android SDK; Expo Go can't load the native engine)
npm run build:web      # production web export → dist/
npm run typecheck && npx eslint .
npm run test:e2e       # Playwright smoke test; BASE=http://… to target another server
npm run sample         # regenerate the bundled sample guide PDF (needs reportlab)
node scripts/make-icons.mjs  # regenerate icons from the mark
```

## Measured (web production build, Chromium, 600-page PDF, DPR 2)

| | |
|---|---|
| Import → first page painted | ~0.7 s |
| Jump to page 480 → painted | ~0.13 s |
| Full-text search, 600 pages | ~0.36 s, no main-thread long tasks |
| Fling across ~70 pages | no long tasks |

## Status

- Web: complete and covered by `e2e/smoke.mjs` (desktop + mobile viewports).
- Native: the engine module (`modules/pdf-engine`) is written but **not yet compiled or run on a device**. Android search requires API 35+, and PdfRenderer exposes no outline.

## License

[GNU AGPL-3.0-or-later](LICENSE) with an [app store permission](LICENSE-EXCEPTION.md). Use, study, modify and share freely. Any distributed or network-hosted version, modified or not, must publish its complete source under the same license, so Tessel can't be turned into closed, proprietary software.

The name and mark are covered by the [trademark policy](TRADEMARKS.md): forks are welcome under a different name. Contributions: see [CONTRIBUTING.md](CONTRIBUTING.md).

## Deployment

`.github/workflows/web.yml` typechecks, lints, builds the web app under `/<repo>/`, runs the e2e smoke test against that build, and on `main` publishes it to GitHub Pages. One-time setup: Settings → Pages → Source: **GitHub Actions**.
