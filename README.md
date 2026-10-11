# Quire

A quiet place to read. Local-first PDF reader: native-first (iOS, Android) with a first-class web build from one Expo codebase.

## Principles

1. **Content is the interface.** Chrome fades while reading forward and returns on a scroll back, a tap, or the pointer nearing an edge.
2. **Performance before size.** Each platform's best PDF engine, rendering off the main thread, scheduled by distance from the page being read.
3. **Remember faithfully.** Position, bookmarks and preferences persist per device; reopening lands on the exact line.
4. **One voice.** Newsreader for reading-adjacent type, Inter for interface, warm paper neutrals, one ink accent per theme.

## Scope (MECE)

| Domain | Shipped | Next |
|---|---|---|
| Library — acquire, organise, resume | Picker, drag-and-drop, OS "Open with" (PWA File Handling), page-1 covers, continue-reading, filter, remove | Collections, sort, share-sheet import on native |
| Reader — render, navigate, find | Virtualised continuous scroll, fit width/page, zoom (buttons, ⌘±, trackpad/pinch), outline, page grid, spine scrubber with chapter notches, go-to-page, full-text search with on-page highlights | Text selection layer, two-page spread, reflow |
| Marking | Bookmarks | Highlights, notes, export |
| Personalisation | Paper, Sepia, Dusk, Night (OLED), Auto | Typography for reflow, TTS |
| Platform | Offline PWA, IndexedDB / app-documents storage, keyboard map, a11y labels | EAS builds, sync |

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
npm run sample         # regenerate the bundled sample PDF (needs reportlab)
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
