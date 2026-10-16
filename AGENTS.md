# Tessel — agent notes

Expo SDK 57 / React Native 0.86 app. Expo APIs change every SDK: verify against installed type definitions in `node_modules` rather than memory.

- Install native-compatible versions with `npx expo install`; if the Expo API is unreachable, use the version from `node_modules/expo/bundledNativeModules.json`.
- Routes live in `src/app/`. `src/core/` (engine, reflow, ocr, storage, lib, design, i18n) is what any document app would share; `src/paper/` (archive, scan, reader, components, state) is Tessel's document management on top. core never imports paper or app (ESLint enforces it).
- Never hand-edit `ios/` or `android/` (Continuous Native Generation). Native engine code lives in `modules/pdf-engine`.
- UI must depend only on `src/core/engine/types.ts`, never on PDFium or native module internals.
- Product: Tessel, a PDF-only document manager. One screen (Documents, Tessel | Sources); no folders in the Tessel folder (tags and filters instead); the file is the truth (details, text, notes live in the PDF). No reading list, no EPUB.
- Web storage keys still say `quire` on purpose (renaming would orphan existing libraries).
- UI strings live in `src/core/i18n/en.ts` + `de.ts` (German is type-checked against English); never hard-code user-facing text.
- React Compiler is on: keep `npx eslint .` clean (no refs or setState during render or effect bodies).
- After editing `src/core/engine/pdfium/worker.ts` or anything under `src/paper/scan/engine/`, run `npm run engine`.
- Scanner changes (detection, filters, OCR, export): `npm run test:scan -- --max-cer 0.07` must pass (locally, ~45 min; CI runs it only on demand); compare against a previous run with `--baseline`.
- Reflow logic is pure (`src/core/reflow/build.ts`); add a unit test in `build.test.ts` for each heuristic change.
- Before finishing: `npm run typecheck`, `npx eslint .`, `npm test`, `npm run test:e2e` against a running `npm run web` (start Metro without `CI=1`, which disables file watching).
