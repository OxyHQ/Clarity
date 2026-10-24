const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

// Web shim for react-native-track-player (avoids bundling shaka-player)
const trackPlayerWebShim = path.resolve(__dirname, 'lib/shims/react-native-track-player.web.js');

module.exports = (() => {
  const config = getDefaultConfig(__dirname);

  // Enable package exports for zod v4 compatibility
  config.resolver.unstable_enablePackageExports = true;

  // Add web-specific resolver settings to handle ESM modules
  config.resolver.sourceExts = [...config.resolver.sourceExts, 'mjs', 'cjs'];

  const { resolver } = config;
  config.resolver = {
    ...resolver,
    assetExts: [...resolver.assetExts, 'wasm', 'woff2', 'woff'],
    // On web, replace react-native-track-player with a no-op shim so the
    // bundler never pulls in shaka-player (TTS uses expo-speech on web).
    resolveRequest: (context, moduleName, platform) => {
      if (platform === 'web' && moduleName === 'react-native-track-player') {
        return { filePath: trackPlayerWebShim, type: 'sourceFile' };
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  };

  return withNativeWind(config, {
    input: './global.css',
    inlineRem: 16,
    inlineVariables: false,
  });
})();
