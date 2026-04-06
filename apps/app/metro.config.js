const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require('nativewind/metro');

// Web shim for react-native-track-player (avoids bundling shaka-player)
const trackPlayerWebShim = path.resolve(
  __dirname,
  "lib/shims/react-native-track-player.web.js"
);

// Monorepo root and linked package roots that live outside the project tree
const monorepoRoot = path.resolve(__dirname, "../..");
const bloomRoot = path.resolve(require.resolve("@oxyhq/bloom/package.json"), "..");

module.exports = (() => {
  const config = getDefaultConfig(__dirname);

  // Let Metro watch directories outside the project (symlinked deps)
  config.watchFolders = [monorepoRoot, bloomRoot];

  // Enable package exports for zod v4 compatibility
  config.resolver.unstable_enablePackageExports = true;

  // Ensure Metro can find node_modules from both the project and the monorepo root
  config.resolver.nodeModulesPaths = [
    path.resolve(__dirname, "node_modules"),
    path.resolve(monorepoRoot, "node_modules"),
  ];

  // Add web-specific resolver settings to handle ESM modules
  config.resolver.sourceExts = [...config.resolver.sourceExts, 'mjs', 'cjs'];

  // SVG support for react-native-svg-transformer (Expo transformer)
  const { transformer, resolver } = config;
  config.transformer = {
    ...transformer,
    babelTransformerPath: require.resolve("react-native-svg-transformer/expo"),
  };
  config.resolver = {
    ...resolver,
    assetExts: resolver.assetExts.filter((ext) => ext !== "svg"),
    sourceExts: [...resolver.sourceExts, "svg"],
    // On web, replace react-native-track-player with a no-op shim so the
    // bundler never pulls in shaka-player (TTS uses expo-speech on web).
    resolveRequest: (context, moduleName, platform) => {
      if (platform === "web" && moduleName === "react-native-track-player") {
        return { filePath: trackPlayerWebShim, type: "sourceFile" };
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  };

  return withNativeWind(config, {
    input: './global.css',
    inlineRem: 16
  });
})();
