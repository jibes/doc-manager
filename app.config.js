// Web deploys under a sub-path (GitHub Pages) set EXPO_BASE_URL, e.g. "/doc-manager".
module.exports = ({ config }) => ({
  ...config,
  experiments: { ...config.experiments, baseUrl: process.env.EXPO_BASE_URL || undefined },
});
