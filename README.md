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
| Personalisation | Light, Dark, Auto; Invert colours per document; English and German (follows OS) | More languages |
| Platform | Offline PWA, install button, IndexedDB / app-documents storage, keyboard map, a11y labels | EAS builds |

## Install on Android

Tessel for Android is on the [Releases](https://github.com/jibes/doc-reader/releases) page: download `tessel-x.y.z.apk` on the phone and open it (allow installs from the browser or file manager when Android asks). For automatic updates, add `https://github.com/jibes/doc-reader` in [Obtainium](https://github.com/ImranR98/Obtainium).

The app is the web app bundled in a native shell (`shell/android`): every feature works offline, and it appears under **Open with** and **Share** for PDFs and EPUB books. A PDF opened from another app is shown first and filed after: the page starts the PDF engine and reads the file before the app's code runs (`public/index.html`), the app starts on a bare screen, opens the document from the bytes in hand and hands the open document to the reader (`openIncoming`, `src/reader/preopened.ts`); it is stored, copied into Documents/Tessel and given its cover once its first page is up. Releases are signed with this certificate (SHA-256), which Obtainium or AppVerifier can check:

```
F9:AF:FA:64:D7:53:51:D8:BE:43:4E:99:05:C4:6D:B2:C2:51:9C:36:D8:0E:9B:A5:A3:71:F6:A6:F5:8E:E3:94
```

**Appearance.** Light, Dark or Auto. Auto follows the system's light or dark mode; in the Android app, while the system is light, the phone's light sensor also turns it Dark when the room is dim (switching only after the light has held for a few seconds; the sensor runs only while Auto is chosen and the app is in front). In Dark, PDF pages keep their printed colours but are shown slightly dimmed and warm, so a white page doesn't glare; text view follows the appearance. *Invert colours* (Aa, page view) is remembered per document, for dark slides or long night reading.

**Navigation.** Two places and one action, each answering one question (`src/components/AppNav.tsx`): **Reading** (what am I reading: Continue, the reading list, the last 20 opened, Open file), **Scan** (make a new one), **Documents** (where is it: the one search, the inbox and sync issues as first rows, saved views, filters by tag, sender, type, year and place, and the **Folders** view, which browses the places with the archive first, marked as synced, its Trash under it, and “Other location…”, the system picker, for single files from anywhere). Phones have them along the bottom (Scan in the middle; the inbox count on Documents), wider windows in a sidebar (with Inbox, Folders and Trash under Documents, Scan and Settings below). The Android app and an installed web app open where they were last used; a browser tab follows its address. Every document is in one place: the **archive** (synced, searched, reading shared, inbox and trash), **other folders** (searched), or **this device** only (searched); ⋯ → Keep in archive moves a document to the archive's Inbox, keeping its reading state. The reader's bar has one button per kind of action: **Find** (a search field over the contents, pages, bookmarks and notes; ⌘F or T), **Text view** (lit while on; V), **Aa** (how it looks) and **⋯** (reading list, share, download, print).

**Where documents live.** In the Android app every document is a real file: scans and files opened from other apps go to **Documents/Tessel** (first in Files), and the library links to them. Browsers without folder access keep a copy in browser storage instead (“This browser only”).

**Folders.** Documents → Folders browses your folders as a grid of first-page and cover thumbnails (made on the device, cached until a file changes). By default Tessel sees only folders you add through Android's folder picker. In Settings you can optionally turn on **all files access**, which adds “All documents” (every PDF and EPUB on the device, newest first) and “Internal storage”. Documents open where they are, and saving edits writes back to them. Long-press (right-click on a computer) or the select button picks items to share, copy, move, rename or delete; new folders are one tap. Renamed and moved documents stay in the library, deleted ones leave it. On a computer, Chrome and Edge browse folders the same way.

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
src/scan/           document scanner (web): session.ts (draft), save.ts, export.ts + exportCache.ts (searchable PDF), ui/ (camera, crop, page image)
  engine/             framework-free: page detection, imaging and filters, PaddleOCR, PDF writer, workers
src/engine/         DocumentEngine contract (types.ts)
  index.web.ts        → PDFium WASM in a Web Worker (src/engine/pdfium/worker.ts)
  index.ts            → native module modules/pdf-engine
modules/pdf-engine/ local Expo module — iOS: PDFKit (Swift), Android: PdfRenderer (Kotlin)
```

UI depends only on `src/engine/types.ts`. Platform files (`*.web.ts`) pick the implementation at bundle time.

**Text view.** The worker extracts lines with typography (size, weight, hyphenation) and, for tagged PDFs, structure roles; untagged artifacts (running heads/footers) are dropped. `src/reflow/build.ts` removes repeated headers, footers and page numbers, detects body size and headings, splits paragraphs and lists, rejoins hyphenated words and paragraphs across pages and columns, and reports scans with no text layer. The worker also reports images and clustered vector drawings; `src/reflow/layout.ts` keeps those that read as figures (with nearby labels and captions), detects tables (aligned short cells, or table tags) and shows both as sharp crops of the page, and finds column gutters to read multi-column pages column by column, with full-width bands in between. For scans, text view offers recognition with Tesseract running in its own worker (English, plus German for a German UI); models load from the app's own origin on first use, nothing is uploaded, and results are stored per page so recognition resumes and never repeats. Blocks keep their source page and position, so both views share one reading position.

**Scanner.** Scan (home screen, web and Android app): the camera finds the page live and takes it once the phone is held steady (or on the shutter); photos can be imported instead. Pages can be filtered (Document, B&W, Grey, Colour, Original), turned, cropped by their corners (with a loupe) or retaken; press and hold a page to drag it to a new place, or Select several to turn, move to the start or end, filter or delete them together (each undoable). The draft survives a reload. Save writes a searchable PDF into a chosen folder (or the library only) and opens it. Engine ported from doc-scanner. Three workers (built into `public/engine` by `npm run engine`): detection finds the page corners with the DocAligner model and refines them against the photo's edges; processing rectifies, filters and encodes pages; OCR reads them with PaddleOCR PP-OCRv5 and turns sideways or upside-down pages upright. Models (Apache-2.0, `public/models`, ~17 MB) run in ONNX Runtime Web, load from the app's own origin on first use and never leave the device. Export renders pages in the background and writes a PDF with an invisible text layer. `npm run test:scan` photographs synthetic documents with known corners and text and runs them through the real workers and export; it reports corner error, ink kept and character error rate (`--max-cer` fails a run above a limit).

**Details.** Reader ⋯ → Details edits a PDF's title, sender, type, date and tags, kept in the file itself: Title, Author, Subject, Keywords (tags, comma-separated) and a DocumentDate entry (YYYY-MM-DD) in its information dictionary, so other apps and other devices see them (a folder synced with Syncthing carries them along). They are written by an incremental update (`src/archive/pdfInfo.ts`): a new dictionary and cross-reference section (table or stream, as the file has) appended to the file's bytes, which stay as they were; Syncthing then only sends the appended blocks. Encrypted PDFs are left alone. The document is reopened from the file afterwards. Scans read with AI get the same entries.

**Search across documents.** The search field in Documents searches every PDF in the user's folders (walked with their subfolders, the archive first; hidden ones such as `.stversions` and `.tessel` are skipped; with all files access, every other document on the device too) and in the library: their text, details and file names. The index is built on each device in the background (`src/archive/indexer.ts`) and never synced: documents are read with PDFium (up to 200 pages each) when new or changed (size or date) or after Tessel wrote to them, one at a time, waiting while a document is open; their details are kept in IndexedDB and read at start (small: the Documents list and its filters need only them); their text is kept, indexed and searched with MiniSearch (prefix and typo-tolerant, every word required; title, sender and tags weigh more) in a worker (`src/archive/searchWorker.ts`), so building the index never holds up the app. The worker builds it when Documents opens and saves it after changes (with the documents changed since, applied again when it is loaded), so later starts only load it. A hit opens at the page with the match, highlighted. Documents without text (scans that were never read) are found by their details and name.

**Documents.** Every indexed document as one list: searched, narrowed by tag, sender, type and year (`src/archive/facets.ts`; each choice shows how many documents it leaves, counted within the other choices, values matched ignoring case; the year is the document's date, else the file's), and sorted (Sort by, next to the count: newest or oldest first, name, largest first; search results best match first until another order is chosen). Each row shows the date (the document's, else the file's) and the folders it is in. A search and its filters can be saved as a view. Views are kept in the archive folder (Settings → Archive folder, the folder synced to the other devices) as `.tessel/views.json`, read again when the screen opens and changed by reading, editing and writing back at once, so a view saved on another device meanwhile is kept; without an archive folder they stay on the device and move there when one is chosen.

**Inbox.** New documents go into the archive folder's `Inbox/` (scans save there by default once an archive is chosen; files dropped in by any device count too). One device sorts it (Settings → Sort the inbox on this device; off by default, so two devices never file the same document). The Inbox screen reads each PDF's details and first pages and proposes details: its own, a date found in the text (`findDate`: 02.10.2026, 2026-10-02, 2. Oktober 2026, October 2, 2026), then the rules from `.tessel/rules.json`, where a rule's words (all of them, or of one comma-separated alternative) in the text give a sender, type and tags (`src/archive/rules.ts`). With AI set up, "Suggest with AI" sends the text (not images) for the rest. Filing writes the details into the PDF (an incremental update, as in Details), saves it where the name template puts it (default `{year}/{sender}/{date} {title}`, path parts made safe for every system Syncthing may sync to), and only then removes it from the inbox.

**Searchable scans.** A PDF whose first page has no text (a scan from elsewhere) offers ⋯ → Make searchable; the inbox does it when filing such a document (and reads its first page early, so rules and the date work on it). Pages without text (`src/archive/searchable.ts`) are rendered at 2600 px, read on the device by the scanner's PaddleOCR (sideways and upside-down pages found and read upright), and get invisible Helvetica text over each word, stretched to its box along the line, written by PDFium (text objects in render mode 3) and saved as an incremental update, so the file's bytes stay as they were. Details that are a tool's placeholder ("untitled", "anonymous", "(unspecified)") count as none, in the inbox and in the index.

**Sync safety.** Built for an archive folder synced by Syncthing (`src/archive/sync.ts`, `trash.ts`). Deleting inside the archive moves to `.tessel/trash` (synced, so a deletion that reached every device can be undone): no question asked, Undo in the message, `.tessel/trash.json` remembering each item's folder, a Trash screen (Documents → Folders, under the archive) to restore or delete for good, and items gone after 30 days. Syncthing's conflict copies (`name.sync-conflict-YYYYMMDD-HHMMSS-DEVICE.pdf`) and its temporaries are kept out of the index; conflicts and documents in the archive with the same content (SHA-256, kept in the index; copies elsewhere on the device aren't the archive's to tidy) are listed on the Sync screen (a row at the top of Documents when there are any) to keep one version, keep both (the copy renamed after its device), or open each; the version not kept goes to the trash. The inbox points out a document that is already filed. In the Android app, files on the device and in the Tessel folder are written to a hidden temporary file and renamed over the old one, so Syncthing never picks up a half-written file (folders picked through the system's document providers can't be renamed over; there the file is staged first and copied in one go; in browsers, Chromium already writes through a temporary file).

**Reading on every device.** With an archive folder (and Settings → Share reading with my other devices, on by default), the reading list, the position in each document and its bookmarks follow the user between devices (`src/archive/shared.ts`, `sharing.ts`). A document is recognised on every device by a hash of its bytes up to the first `%%EOF` (so details, text layers and other incremental updates, which are appended, don't change it; library copies and folder files match too). Each device writes only its own `.tessel/state/<device>.json` (no two writers, so no sync conflicts), with each value stamped with when it changed; every device reads them all and takes the newest of each value per document. Values first shared are stamped with when they happened here (and a default, such as not being on the list, isn't news), so a device that just added a document doesn't undo another's reading list. A document on another device's reading list that is in the archive comes into this library. Passes run a little after start, when the app is shown or hidden, every minute while in use, and soon after a change.

**AI reading (optional).** Settings → AI reading takes an API type (Anthropic Messages, or the OpenAI-compatible Chat Completions that OpenAI, Ollama, LM Studio and vLLM speak), an address, a key and a model; nothing is built in. With it set up, a scan offers "Read with AI": on save, the page images (1568 px JPEGs) and the lines read on the device go to that address in one request asking for structured JSON (`src/scan/ai.ts`). The reply corrects each line in place in the text layer, adds what the device missed (handwriting) at the box the model gives, and describes the document: when no title was typed, the file is named "date sender – title", and sender, type and keywords go into the PDF's Author, Subject and Keywords. A server without structured output is asked again without it; if the request fails, the scan is saved with the device's text and the user is told. Off by default; the key stays on the device. Replies are streamed, so a proxy on the way (Cloudflare closes a request after ~100 s without a byte) doesn't cut off a long reading; in the Android app the request is made by the app itself, since the WebView's own origin isn't one an address's CORS rules allow. (Anthropic's SDK can't initialise in the Metro web bundle, so both APIs are called with `fetch`.)

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
npm run test:scan      # scanner quality: detection, filters, OCR error rate → e2e/out/scan/report.md (needs poppler-utils)
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
