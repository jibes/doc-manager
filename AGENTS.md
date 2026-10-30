# Tessel — agent notes

Expo SDK 57 / React Native 0.86 app. Expo APIs change every SDK: verify against installed type definitions in `node_modules` rather than memory.

- Install native-compatible versions with `npx expo install`; if the Expo API is unreachable, use the version from `node_modules/expo/bundledNativeModules.json`.
- Routes live in `src/app/`. `src/core/` (engine, reflow, ocr, storage, lib, design, i18n) is what any document app would share; `src/paper/` (archive, scan, reader, components, state) is Tessel's document management on top. core never imports paper or app (ESLint enforces it).
- UI must depend only on `src/core/engine/types.ts`, never on PDFium or native module internals.
- Product: Tessel, a PDF-only document manager. One screen (Documents); one Tessel folder, chosen in Settings (no sources); no folders in the Tessel folder (tags and filters instead); the file is the truth (details, text, notes live in the PDF). No reading list, no EPUB.
- Web storage keys still say `quire` on purpose (renaming would orphan existing libraries).
- UI strings live in `src/core/i18n/en.ts` + `de.ts` (German is type-checked against English); never hard-code user-facing text.
- React Compiler is on: keep `npx eslint .` clean (no refs or setState during render or effect bodies).
- After editing `src/core/engine/pdfium/worker.ts` or anything under `src/paper/scan/engine/`, run `npm run engine`.
- Scanner changes (detection, filters, OCR, export): `npm run test:scan -- --max-cer 0.07` must pass (locally, ~45 min; CI runs it only on demand); compare against a previous run with `--baseline`.
- Reflow logic is pure (`src/core/reflow/build.ts`); add a unit test in `build.test.ts` for each heuristic change.
- A new route needs `.expo/types/router.d.ts` regenerated (`npx expo start` once), or move the file away before `npm run typecheck`; CI has none.

## Shells (what ships)
Every platform runs the same web export; the shells only host it and add what a browser can't do.
- **Android** (`shell/android`, Kotlin, no framework): `MainActivity` hosts the WebView and receives VIEW/SEND intents; `Bridge.kt` is the JS bridge `TesselShell` (files in, print, share, folders); `Folders.kt` the Storage Access Framework tree and All files access; `TesselDocuments.kt` a documents provider that shows the Tessel folder in other apps' file pickers. The web side of the bridge is `src/core/lib/shell.ts`; change both sides together and keep the e2e fake shell (`e2e/smoke.mjs`) in step.
- **Desktop** (`shell/desktop`, Electron): `main.js` (window, menus, file association, second window, update notice) and `preload.js`. Built from `npm run build:desktop-web`; macOS in CI, unsigned.
- Never hand-edit `ios/` or `android/` (Continuous Native Generation). `modules/pdf-engine` (React Native native path) is frozen, never built or shipped (STANDARD D8): don't extend it.

## Releases
- `package.json` `version` is the single source: pushing a version that has no tag yet to `main` releases it. `android.yml` builds, smoke-tests on an emulator, waits for the Web checks on that commit, then publishes the signed APK as GitHub release `vX.Y.Z`; `desktop.yml` attaches the Mac `.dmg`/`.zip` to it.
- Each version has its notes in `docs/releases/X.Y.Z.md` (first line a **bold lead**), used as the release body. Write them before bumping (`npm version X.Y.Z --no-git-tag-version`).
- versionCode = major·10⁷ + minor·10⁵ + patch·10³ (minor and patch below 100). Signing secrets are `ANDROID_*`; without them a release fails.

## Deviations from apps-data STANDARD.md v1
| Standard | Here | Why |
|---|---|---|
| Vite, `src/i18n`, `tests/` | Expo (Metro) web export; `src/core/i18n`; tests next to the code | Expo app from the start; a move would cost weeks and gain nothing |
| vite-plugin-pwa | Hand-written `public/sw.js`, cache name stamped per build by `scripts/postexport.mjs` | Allowed by the standard; one cache per build |
| Capacitor | Own Kotlin shell; Electron for desktop | Allowed by the standard (D2) |
| `@playwright/test` | Hand-rolled `e2e/smoke.mjs` on playwright-core (`ONLY=…`, `SHARD=i/n`) | ~3800 lines to port; sharding already works |
| Prettier | None; never run `prettier --write` here | It would reformat every file in one diff |
| PRs only (D4) | Agents push to `main` | Owner's choice; deploy and release run only after all checks pass |
| `ci.yml` + `deploy.yml` | `web.yml` (checks, build, 4 e2e shards, deploy), `android.yml`, `desktop.yml`, `scan.yml` | Same gates, jobs in parallel |
| Binaries over 1 MB out of git | ONNX models (17 MB) in `public/models` with NOTICE and SHA-256s | Already in history; release assets would clutter the releases Obtainium reads |
| Files under 800 lines | Six above (largest `scan/engine/detect/quadSearch.ts`) | Split one when it is next changed, not in one go |

## Before finishing
`npm run typecheck`, `npm run lint`, `npm test`, and `npm run test:e2e` (`ONLY=<suites>` for what changed) against a running `npm run web` (start Metro without `CI=1`, which disables file watching) or a served `dist`. CI runs the whole e2e in four shards before anything deploys or releases.
