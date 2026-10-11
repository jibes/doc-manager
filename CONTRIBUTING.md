# Contributing

Thanks for helping. A few things keep the project healthy:

- **Sign off your commits** (`git commit -s`), certifying the [Developer Certificate of Origin](https://developercertificate.org/).
- **Licensing of contributions:** by contributing you agree that your contribution is licensed under AGPL-3.0-or-later **including the app store permission in [LICENSE-EXCEPTION.md](LICENSE-EXCEPTION.md)**. Without that, the app couldn't ship to the App Store or Play Store.
- **Before opening a PR:** `npm run typecheck`, `npx eslint .`, and `npm run test:e2e` against `npm run web`.
- **UI text** goes in `src/i18n/en.ts` and `src/i18n/de.ts`; never hard-code user-facing strings.
- **No ads, tracking or accounts.** Features that need them won't be merged.
