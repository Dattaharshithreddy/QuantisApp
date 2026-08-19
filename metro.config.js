const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Add .cjs extension support for Firebase JS SDK v10
config.resolver.sourceExts.push('cjs');

module.exports = config;
