// Web deploys under a sub-path (GitHub Pages) set EXPO_BASE_URL, e.g. "/doc-manager".
module.exports = ({ config }) => ({
  ...config,
  // The release's version (npm version sets it), shown in Settings.
  version: require('./package.json').version,
  experiments: { ...config.experiments, baseUrl: process.env.EXPO_BASE_URL || undefined },
});
