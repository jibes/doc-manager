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
| Home — acquire, organise, resume | Open/picker, drag-and-drop, OS "Open with" (PWA File Handling), Recent list, reading list with progress + Finished, filter, remove (keeps the original); **open in place** in Chromium (File System Access: the library links to your file, re-asks permission, finds moved files; copy elsewhere) | Open in place on native |
| Viewer — render, navigate, find, act | Virtualised continuous scroll, fit width/page, zoom (buttons, ⌘±, trackpad/pinch), outline, page grid, scrubber with chapter marks, go-to-page, full-text search with persistent highlights and find bar, selectable text (web), internal + web links, password-protected PDFs (password kept for the session only), share / download / print (⌘S, ⌘P); **fill forms** (text, checkbox, radio, dropdown, list); **highlights and notes** from a text selection, listed under Notes, from any app; Save writes into the original (in place) or Tessel's copy | Text selection, links, forms and annotations on native (PDFium on all platforms); ink, shapes |
| Reading | **EPUB books** (EPUB 2 and 3: contents, footnotes, inline formatting, images; straight onto the reading list); reading list, immersive chrome, progress, bookmarks; **text view** (reflow) with font, size, line spacing and width settings, position shared with page view; multi-column layouts, inline figures and tables, search highlights; on-device OCR for scans (web) | Text view and OCR on native |
| Personalisation | Light, Sepia, Dark, Black, Auto; English and German (follows OS) | More languages |
| Platform | Offline PWA, install button, IndexedDB / app-documents storage, keyboard map, a11y labels | EAS builds |

## Install on Android

Tessel for Android is on the [Releases](https://github.com/jibes/doc-reader/releases) page: download `tessel-x.y.z.apk` on the phone and open it (allow installs from the browser or file manager when Android asks). For automatic updates, add `https://github.com/jibes/doc-reader` in [Obtainium](https://github.com/ImranR98/Obtainium).

The app is the web app bundled in a native shell (`shell/android`): every feature works offline, and it appears under **Open with** and **Share** for PDFs and EPUB books. Releases are signed with this certificate (SHA-256), which Obtainium or AppVerifier can check:

```
F9:AF:FA:64:D7:53:51:D8:BE:43:4E:99:05:C4:6D:B2:C2:51:9C:36:D8:0E:9B:A5:A3:71:F6:A6:F5:8E:E3:94
```

**Files.** The folder button on the home screen browses your folders as a grid of first-page and cover thumbnails (made on the device, cached until a file changes). By default Tessel sees only folders you add through Android's folder picker. In Settings you can optionally turn on **all files access**, which adds “All documents” (every PDF and EPUB on the device, newest first) and “Internal storage”. Documents open where they are, and saving edits writes back to them. Long-press (right-click on a computer) or the select button picks items to share, copy, move, rename or delete; new folders are one tap. Renamed and moved documents stay in the library, deleted ones leave it. On a computer, Chrome and Edge browse folders the same way.

Building: `npm run build:android-web`, then `./gradlew assembleRelease` in `shell/android` (Android SDK, JDK 17). CI builds every push, tests the APK on an emulator, and publishes a signed release when `package.json`'s version on main is new (or for a `v*` tag, or a manual run of the Android workflow with a version) (signing key from the `ANDROID_*` repository secrets).

## Architecture

```
src/app/            routes (expo-router): library, read/[id]
src/reader/         reading surface: layout math, raster cache + scheduler, scrubber, panels
src/components/     shared UI primitives, covers, empty state, drop zone
src/design/         tokens: palettes, type scale, spacing, motion
src/state/          zustand stores: library, prefs
src/storage/        persistence port — index.web.ts (IndexedDB) | index.ts (expo-file-system)
src/reflow/         text view: layout.ts (figures, tables, columns) + build.ts (blocks); pure, unit-tested
src/book/           EPUB: epub.ts (container, OPF, nav/NCX), html.ts (XHTML → blocks), index.ts (virtual pages); pure, unit-tested
src/ocr/            on-device text recognition — index.web.ts (Tesseract WASM, self-hosted) | index.ts (none yet)
src/engine/         DocumentEngine contract (types.ts)
  index.web.ts        → PDFium WASM in a Web Worker (src/engine/pdfium/worker.ts)
  index.ts            → native module modules/pdf-engine
modules/pdf-engine/ local Expo module — iOS: PDFKit (Swift), Android: PdfRenderer (Kotlin)
```

UI depends only on `src/engine/types.ts`. Platform files (`*.web.ts`) pick the implementation at bundle time.

**Text view.** The worker extracts lines with typography (size, weight, hyphenation) and, for tagged PDFs, structure roles; untagged artifacts (running heads/footers) are dropped. `src/reflow/build.ts` removes repeated headers, footers and page numbers, detects body size and headings, splits paragraphs and lists, rejoins hyphenated words and paragraphs across pages and columns, and reports scans with no text layer. The worker also reports images and clustered vector drawings; `src/reflow/layout.ts` keeps those that read as figures (with nearby labels and captions), detects tables (aligned short cells, or table tags) and shows both as sharp crops of the page, and finds column gutters to read multi-column pages column by column, with full-width bands in between. For scans, text view offers recognition with Tesseract running in its own worker (English, plus German for a German UI); models load from the app's own origin on first use, nothing is uploaded, and results are stored per page so recognition resumes and never repeats. Blocks keep their source page and position, so both views share one reading position.

**Books.** An EPUB is unzipped (fflate) and its chapters parsed (htmlparser2) into the same blocks the PDF text view uses, with inline runs for emphasis, links and footnote marks, images as figures, tables row by row. Blocks are paginated into virtual pages of about 1,800 characters, each chapter starting a new page, so progress, bookmarks, contents, the scrubber and "finished" work as for PDFs. Pure TypeScript with no DOM: the same code runs in the native app. Finishing needs reading to the end; jumps (contents, links, search hits) that land there don't count.

**Editing.** Forms run through PDFium's own form-fill environment: invisible native controls over each field take input, PDFium sets values (appearances, radio groups) and draws fields with `FFLDraw`. Highlights are standard `/Highlight` annotations with one quad per line and the comment in `/Contents`, so Acrobat and other viewers show them; existing markup from other apps is listed and editable. Edited pages are re-rendered via `RasterCache.invalidate`. Save serialises with `FPDF_SaveAsCopy` and writes back through `repo.writeFile`: to the user's file when opened in place (asking for write access), else to the library copy; share, download and print include unsaved edits.

**Render pipeline.** `RasterCache` de-duplicates requests, refcounts cancellation, keeps ≤ 2 renders in flight and always starts the page closest to the reading position. Web rasters are `ImageBitmap`s transferred from the worker and drawn to `<canvas>`; theme tint is a GPU CSS filter, so switching theme never re-renders. Native rasters are cached JPEG files tinted with a blend-mode overlay.

## Commands

```bash
npm install            # also builds the PDFium worker into public/engine
npm run web            # dev server (http://localhost:8081)
npm run ios|android    # dev build (needs Xcode / Android SDK; Expo Go can't load the native engine)
npm run build:web      # production web export → dist/
npm run typecheck && npx eslint . && npm test   # unit tests (vitest)
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
