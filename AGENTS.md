# Quire — agent notes

Expo SDK 57 / React Native 0.86 app. Expo APIs change every SDK: verify against installed type definitions in `node_modules` rather than memory.

- Install native-compatible versions with `npx expo install`; if the Expo API is unreachable, use the version from `node_modules/expo/bundledNativeModules.json`.
- Routes live in `src/app/`; everything else outside it.
- Never hand-edit `ios/` or `android/` (Continuous Native Generation). Native engine code lives in `modules/pdf-engine`.
- UI must depend only on `src/engine/types.ts`, never on PDFium or native module internals.
- React Compiler is on: keep `npx eslint .` clean (no refs or setState during render or effect bodies).
- After editing `src/engine/pdfium/worker.ts`, run `npm run engine`.
- Before finishing: `npm run typecheck`, `npx eslint .`, `npm run test:e2e` against a running `npm run web` (start Metro without `CI=1`, which disables file watching).
