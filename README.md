# Tessel

**Every document, in its place.** A document manager for PDFs, without a server: no ads, no account, files stay on your devices (synced, if you like, with Syncthing). One Expo codebase: web app and Android app.

Live web app: https://jibes.github.io/doc-reader/

## Principles

1. **The file is the truth.** Details (title, sender, type, date, tags), the text of scans, filled forms, highlights and notes are written into the PDF itself. Other apps and other devices see them; nothing important lives only in Tessel.
2. **Tags, not folders.** The Tessel folder is flat (only `Inbox/` and `.tessel/`). Documents are found by search, filters and saved views, never by remembering where they were filed.
3. **One way in.** Camera or files: everything added becomes a file in the Tessel folder, and pages without text get theirs read, so every document can be searched.
4. **One screen.** Documents: Tessel's own, or the sources it reads, one switch apart. Everything else (inbox, trash, sync issues, duplicates, rules) is one step away.
5. **Performance before size.** PDFium in a worker, rendering off the main thread, scheduled by distance from the page you're on.

## Scope

| Domain | Shipped | Next |
|---|---|---|
| Documents — add, find, tidy | Add: camera (scanner) or files, into the Tessel folder (its Inbox once a synced folder is chosen); on-device text for pages without any, AI reading optional (default in Settings, switch per add); search across every document's text and details; filters by tag, sender, type, year; saved views; Tessel \| Sources; inbox with rules and a flat name template; trash; Syncthing conflicts; duplicates (identical files, older versions, with the space freed); flatten old folders once | Rules learned from filing |
| Viewer — render, navigate, find, act | Virtualised continuous scroll, fit width/page, zoom (buttons, ⌘±, trackpad/pinch), outline, page grid, scrubber with chapter and note marks, go-to-page, full-text search with find bar, selectable text, links, password-protected PDFs, share / download / print; **fill forms**; **highlights and notes** (also a note on a page, B); **text view** (reflow) with typography settings; Save writes into the file | Ink, shapes |
| Personalisation | Light, Dark, Auto (light sensor in the Android app); Invert colours per document; English and German (follows OS) | More languages |
| Platform | Offline PWA (each build its own cache), install button, the browser's own Tessel folder (OPFS) or folders picked in Chrome and Edge; Android app with Documents/Tessel and picked folders; keyboard map, a11y labels | iOS |

## Install on Android

Tessel for Android is on the [Releases](https://github.com/jibes/doc-reader/releases) page: download `tessel-x.y.z.apk` on the phone and open it (allow installs from the browser or file manager when Android asks). For automatic updates, add `https://github.com/jibes/doc-reader` in [Obtainium](https://github.com/ImranR98/Obtainium).

The app is the web app bundled in a native shell (`shell/android`): every feature works offline, and it appears under **Open with** and **Share** for PDFs. A PDF opened from another app is shown first and filed after: the page starts the PDF engine and reads the file before the app's code runs (`public/index.html`), the app starts on a bare screen, opens the document from the bytes in hand and hands the open document to the reader (`openIncoming`, `src/paper/reader/preopened.ts`); it is only viewed, and ⋯ → Keep in Tessel (or saving something into it) copies it into Documents/Tessel. Releases are signed with this certificate (SHA-256), which Obtainium or AppVerifier can check:

```
F9:AF:FA:64:D7:53:51:D8:BE:43:4E:99:05:C4:6D:B2:C2:51:9C:36:D8:0E:9B:A5:A3:71:F6:A6:F5:8E:E3:94
```

**Appearance.** Light, Dark or Auto. Auto follows the system's light or dark mode; in the Android app, while the system is light, the phone's light sensor also turns it Dark when the room is dim (switching only after the light has held for a few seconds; the sensor runs only while Auto is chosen and the app is in front). In Dark, PDF pages keep their printed colours but are shown slightly dimmed and warm, so a white page doesn't glare; text view follows the appearance. *Invert colours* (Aa, page view) is remembered per document, for dark slides or long night reading.

**One screen.** Documents (`src/app/documents.tsx`) is the app: the header (Open file, list or grid, ⋯ and Settings), the search, a line when the inbox has documents to review, the filters and saved views, the count with the order (last opened by default; date, name or size; the arrow turns it round), and the list, 100 rows at a time and more as its end comes near. **+** adds: Camera (the scanner) or Files. **Tessel | Sources** switches between the Tessel folder's documents and the sources' (shown once there are sources); a search says how many matches the other side has, and a tap goes there. ⋯ has the inbox, trash, duplicates, sync issues, rules and installing the app. A long press (right click on a computer) picks documents (`src/paper/components/Selection.tsx`; ✕, Esc and Back end it): Tessel's are shared, renamed or deleted (inside the Tessel folder to its trash, with Undo); a source's are kept (copied into the Tessel folder, as anything added), shared or deleted. There is no copy, move or new folder.

**Where documents live.** Every document is in one of two places. The **Tessel folder** is everything Tessel keeps: the folder chosen for it in Settings (usually the one Syncthing syncs, with its `Inbox/` and `.tessel/` for rules, views and trash), else Documents/Tessel in the Android app, or the browser's own storage (the origin-private file system, `src/core/lib/fsa.ts`; Safari and Firefox write it through a worker). **Sources** are folders Tessel reads, added and removed in Settings (Android's folder picker; Chrome and Edge on a computer); their PDFs open where they are and saving writes back to them. There is no whole-device browsing. A file opened from elsewhere (another app, a share, Open file, a drop) is only viewed: where it was left goes into a history of the last 20 on this device (`src/paper/state/viewed.ts`); keeping it, or saving a note, form or details into it, adds it the one way in.

**What this device remembers.** When each document was last opened, where it was left, its view and Invert (`src/paper/state/cache.ts`, IndexedDB, keyed by the document's content key): never synced, and lost without harm (documents then open at the start). Bookmarks from before 3.0 became notes on their pages, once. The old shared reading state (`.tessel/state/`) is no longer read.

**Flat, once.** Settings → Flatten (shown while the Tessel folder has folders with PDFs in them, from before 3.0) moves those PDFs up into it (`src/paper/archive/flatten.ts`): nothing is overwritten (a name already there gets "(2)"), emptied folders go, folders with other files stay; it says what it did.

**Duplicates.** ⋯ → Duplicates (`src/paper/archive/duplicates.ts`) groups identical files (same SHA-256; the copy in the Tessel folder stays, else the oldest) and older versions (same content key, different bytes; the newest stays), each with the space removing the others frees.

Building: `npm run build:android-web`, then `./gradlew assembleRelease` in `shell/android` (Android SDK, JDK 17). CI builds every push, tests the APK on an emulator, and publishes a signed release when `package.json`'s version on main is new (or for a `v*` tag, or a manual run of the Android workflow with a version) (signing key from the `ANDROID_*` repository secrets).

## Architecture

```
src/app/              routes (expo-router): documents (the one screen), read/[id], scan/*, inbox, trash, sync, duplicates, rules, settings
src/core/             what any document app would share; never imports paper or app (ESLint enforces it)
  engine/               DocumentEngine contract (types.ts) — index.web.ts: PDFium WASM in a Web Worker | index.ts: modules/pdf-engine
  reflow/               text view: layout.ts (figures, tables, columns) + build.ts (blocks); pure, unit-tested
  ocr/                  Tesseract (text view of scans, web)
  storage/              persistence port — index.web.ts (IndexedDB) | index.ts (expo-file-system)
  lib/                  folders (Android app, File System Access, OPFS), shell bridge, files, keys
  design/ i18n/         tokens; English and German strings
src/paper/            Tessel's document management
  archive/              index + search (worker), facets, details in the PDF, inbox + rules, intake (one way in), searchable, improve, sync safety, trash, duplicates, flatten, views
  scan/                 scanner (web): session, save, export; engine/ (detection, filters, PaddleOCR, PDF writer, workers)
  reader/               reading surface: layout math, raster cache + scheduler, scrubber, panels, forms, annotations
  components/ state/    shared UI; zustand stores (library links, prefs, device cache, viewed history)
modules/pdf-engine/   local Expo module — iOS: PDFKit (Swift), Android: PdfRenderer (Kotlin)
shell/android/        the Android app: WebView shell, folders, bridge
```

UI depends only on `src/core/engine/types.ts`. Platform files (`*.web.ts`) pick the implementation at bundle time.

**Text view.** The worker extracts lines with typography (size, weight, hyphenation) and, for tagged PDFs, structure roles; untagged artifacts (running heads/footers) are dropped. `src/core/reflow/build.ts` removes repeated headers, footers and page numbers, detects body size and headings, splits paragraphs and lists, rejoins hyphenated words and paragraphs across pages and columns, and reports scans with no text layer. The worker also reports images and clustered vector drawings; `src/core/reflow/layout.ts` keeps those that read as figures (with nearby labels and captions), detects tables (aligned short cells, or table tags) and shows both as sharp crops of the page, and finds column gutters to read multi-column pages column by column, with full-width bands in between. For scans, text view offers recognition with Tesseract running in its own worker (English, plus German for a German UI); models load from the app's own origin on first use, nothing is uploaded, and results are stored per page so recognition resumes and never repeats. Blocks keep their source page and position, so both views share one reading position.

**Scanner.** Add → Camera (web and Android app): the camera finds the page live and takes it once the phone is held steady (or on the shutter); photos can be imported instead. Pages can be filtered (Document, B&W, Grey, Colour, Original), turned, cropped by their corners (with a loupe) or retaken; press and hold a page to drag it to a new place, or Select several to turn, move to the start or end, filter or delete them together (each undoable). The draft survives a reload. Save writes a searchable PDF where anything added goes (the Tessel folder, its Inbox once a synced folder is chosen) and opens it. Engine ported from doc-scanner. Three workers (built into `public/engine` by `npm run engine`): detection finds the page corners with the DocAligner model and refines them against the photo's edges; processing rectifies, filters and encodes pages; OCR reads them with PaddleOCR PP-OCRv5 and turns sideways or upside-down pages upright. Models (Apache-2.0, `public/models`, ~17 MB) run in ONNX Runtime Web, load from the app's own origin on first use and never leave the device. Export renders pages in the background and writes a PDF with an invisible text layer. `npm run test:scan` photographs synthetic documents with known corners and text and runs them through the real workers and export; it reports corner error, ink kept and character error rate (`--max-cer` fails a run above a limit).

**Details.** Reader ⋯ → Details edits a PDF's title, sender, type, date and tags, kept in the file itself: Title, Author, Subject, Keywords (tags, comma-separated) and a DocumentDate entry (YYYY-MM-DD) in its information dictionary, so other apps and other devices see them (a folder synced with Syncthing carries them along). They are written by an incremental update (`src/paper/archive/pdfInfo.ts`): a new dictionary and cross-reference section (table or stream, as the file has) appended to the file's bytes, which stay as they were; Syncthing then only sends the appended blocks. Encrypted PDFs are left alone. The document is reopened from the file afterwards. Scans read with AI get the same entries.

**Search across documents.** The search field in Documents searches every PDF in the Tessel folder and the sources (walked with their subfolders; hidden ones such as `.stversions` and `.tessel` are skipped): their text, details and file names. Folders added inside one another list each file once (`src/core/lib/nesting.ts`): the archive keeps everything below it, elsewhere the inner folder lists its own files; adding such a folder says so. The index is built on each device in the background (`src/paper/archive/indexer.ts`) and never synced: documents are read with PDFium (up to 200 pages each) when new or changed (size or date) or after Tessel wrote to them, one at a time, waiting while a document is open; their details are kept in IndexedDB and read at start (small: the Documents list and its filters need only them); their text is kept, indexed and searched with MiniSearch (prefix and typo-tolerant, every word required; title, sender and tags weigh more) in a worker (`src/paper/archive/searchWorker.ts`), so building the index never holds up the app. The worker builds it when Documents opens and saves it after changes (with the documents changed since, applied again when it is loaded), so later starts only load it. A hit opens at the page with the match, highlighted. Every match counts (the number, the filters and the order cover all of them; the list shows 100 rows and adds more as its end comes near); the words around a match are read for the best few at once and for other rows as they are shown, and matches start at the start of a word. Documents follows the index as documents are added, moved or dropped (read again at most every 1.5 s while indexing). Documents without text (scans that were never read) are found by their details and name.

**Inbox.** With a synced Tessel folder, everything added goes into its `Inbox/` (files dropped in by any device count too); Documents shows a line with how many wait. One device sorts it (Settings → Sort the inbox on this device; off by default, so two devices never file the same document). The Inbox screen reads each PDF's details and first pages and proposes details: its own, a date found in the text (`findDate`: 02.10.2026, 2026-10-02, 2. Oktober 2026, October 2, 2026), then the rules from `.tessel/rules.json`, where a rule's words (all of them, or of one comma-separated alternative) in the text give a sender, type and tags (`src/paper/archive/rules.ts`). With AI set up, "Suggest with AI" sends the text (not images) for the rest. Filing writes the details into the PDF (an incremental update, as in Details), names it by the template (default `{date} {sender} {title}`; a file name only, no "/": the Tessel folder has no folders; made safe for every system Syncthing may sync to), saves it in the Tessel folder and only then removes it from the inbox.

**Improve text with AI.** With AI reading set up, ⋯ → Improve text with AI reads a document's text again (`src/paper/archive/improve.ts`): each page's invisible text (an earlier recognition's, or this device's where a page has none) goes to the model with the page's image (1568 px JPEG, four pages per request), as for a new scan, after asking (naming where the pages go). The corrected lines and what the model finds besides (handwriting) replace the page's invisible text, appended to the file as an incremental update; done again, the layer is replaced, not added to. Pages with text of their own (typed text, sideways or nested text: `ocrLayer` in the engine tells them apart) are left as they are; a page read sideways on the device keeps that reading. Leaving the document stops it.

**Searchable scans.** Pages without text are read when a document is added (`src/paper/archive/intake.ts`, in the background, one document after another; the model reads them instead when AI is switched on for that add). A PDF opened with pages without text also offers ⋯ → Make searchable; the inbox reads the first page early, so rules and the date work on it. Pages without text (`src/paper/archive/searchable.ts`) are rendered at 2600 px, read on the device by the scanner's PaddleOCR (sideways and upside-down pages found and read upright), and get invisible Helvetica text over each word, stretched to its box along the line, written by PDFium (text objects in render mode 3) and saved as an incremental update, so the file's bytes stay as they were. Details that are a tool's placeholder ("untitled", "anonymous", "(unspecified)") count as none, in the inbox and in the index.

**Sync safety.** Built for an archive folder synced by Syncthing (`src/paper/archive/sync.ts`, `trash.ts`). Deleting inside the archive moves to `.tessel/trash` (synced, so a deletion that reached every device can be undone): no question asked, Undo in the message (the library forgets its documents of those files only once Undo is gone), `.tessel/trash.json` remembering each item's folder (also as names below the archive, so any device restores it there, made again if it's gone, under its own name again), a Trash screen (⋯ → Trash) to restore or delete for good (asked first), and items gone after 30 days. An item the manifest doesn't know yet (its entry not synced yet) is dated when this device first sees it, never by its file's date. `views.json`, `rules.json` and `trash.json` are only changed after being read: one that is there but can't be read (no access yet after a browser restart, damaged) stops the change instead of being replaced by defaults (`src/archive/settingsFile.ts`). Syncthing's conflict copies (`name.sync-conflict-YYYYMMDD-HHMMSS-DEVICE.pdf`) and its temporaries are kept out of the index; conflicts and documents in the archive with the same content (SHA-256, kept in the index; copies elsewhere on the device aren't the archive's to tidy) are listed on the Sync screen (a row at the top of Documents when there are any) to keep one version, keep both (the copy renamed after its device), or open each; the version not kept goes to the trash (outside the archive folder it is deleted for good, after asking). Documents in the Inbox aren't counted as duplicates; the inbox itself points out a document that is already filed (checked against the filed file's bytes, so a newer revision isn't taken for it). Trash rows show the document's title (kept in `trash.json` when it is trashed), the folder it came from and the days it has left. In the Android app, files on the device and in the Tessel folder are written to a hidden temporary file and renamed over the old one, so Syncthing never picks up a half-written file (folders picked through the system's document providers can't be renamed over; there the file is staged first and copied in one go; in browsers, Chromium already writes through a temporary file).

**AI reading (optional).** Settings → AI reading takes an API type (Anthropic Messages, or the OpenAI-compatible Chat Completions that OpenAI, Ollama, LM Studio and vLLM speak), an address, a key and a model; nothing is built in. The address must be a whole web address (https, or http for a model on the local network), so a key never goes to the app's own site. With it set up, a scan offers "Read with AI", switched on for that scan only, and Add → Files has the same switch (its default in Settings): on save, the page images (1568 px JPEGs) and the lines read on the device go to that address in one request asking for structured JSON (`src/paper/scan/ai.ts`). The reply corrects each line in place in the text layer, adds what the device missed (handwriting) at the box the model gives, and describes the document: when no title was typed, the file is named "date sender – title", and sender, type and keywords go into the PDF's Author, Subject and Keywords. A server that rejects the structured output format, as a status or as an error in a reply that had started ("does not support JSON schema mode"), is asked again with plain JSON, then with no format (other errors aren't retried); the format an address and model took is tried first next time; a reply cut off at the length limit is reported as such; if the request fails, the scan is saved with the device's text and the user is told. Cancelling stops the request (in the Android app too: the app closes its connection). Off by default; the key stays on the device. Replies are streamed, so a proxy on the way (Cloudflare closes a request after ~100 s without a byte) doesn't cut off a long reading; in the Android app the request is made by the app itself, since the WebView's own origin isn't one an address's CORS rules allow. (Anthropic's SDK can't initialise in the Metro web bundle, so both APIs are called with `fetch`.)

**Editing.** Forms run through PDFium's own form-fill environment: invisible native controls over each field take input, PDFium sets values (appearances, radio groups) and draws fields with `FFLDraw`. Highlights are standard `/Highlight` annotations with one quad per line and the comment in `/Contents`, so Acrobat and other viewers show them; existing markup from other apps is listed and editable. Edited pages are re-rendered via `RasterCache.invalidate`. Save serialises with `FPDF_SaveAsCopy` and writes back through `repo.writeFile`: to the user's file when opened in place (asking for write access), else to the copy in browser storage; share, download and print include unsaved edits.

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
