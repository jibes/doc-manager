/** Deploy sub-path (e.g. "/doc-manager" on GitHub Pages); "" in dev. Inlined by babel-preset-expo. */
export const BASE = (process.env.EXPO_BASE_URL ?? '').replace(/\/$/, '');
