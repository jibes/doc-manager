const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// Bundled sample document.
config.resolver.assetExts.push('pdf');

module.exports = config;
