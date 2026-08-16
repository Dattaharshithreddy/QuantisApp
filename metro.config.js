const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Firebase JS SDK v10+ requires these resolver settings for React Native / Hermes
// Without this, Metro loads the browser bundle which uses APIs unavailable in RN
config.resolver.sourceExts = ['jsx', 'js', 'ts', 'tsx', 'cjs', 'json'];

// Resolve Firebase modules correctly for React Native
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Let Metro handle everything normally
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
