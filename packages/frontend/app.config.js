/**
 * `app.json`, plus the two things it cannot say: Noxcturnal on in development
 * only (below), and where Firebase's `google-services.json` (Android push)
 * comes from. The file is not in the
 * repository (it is gitignored), so an EAS build never receives it from the
 * project archive and `expo prebuild` used to fail copying it.
 *
 * An EAS file environment variable `GOOGLE_SERVICES_JSON` provides it on EAS;
 * a local build may use the ignored `./google-services.json`. With neither,
 * the Android app still builds, without FCM push delivery.
 *
 * OTA updates come from Oxy Updates (`withOxyUpdates` in `app.json`, the same
 * client id `app/_layout.tsx` hands the OxyProvider), published on every push to
 * main by `.github/workflows/publish-update.yml`. The runtime is `version`
 * (appVersion policy): bump it for a native change, which also releases a new
 * binary (`.github/workflows/android-release.yml`). android.versionCode and
 * ios.buildNumber are derived from `version`; never set them.
 */
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');

module.exports = ({ config: appJson }) => {
  const config = {
    ...appJson,
    experiments: {
      ...appJson.experiments,
      // Expo's oxc transformer, about 2x faster cold bundles than Babel. Development
      // only: in a production export it keeps the requires of dead platform branches
      // (`if (Platform.OS !== 'web') require(...)`), pulling native-only packages into
      // the web bundle. The CLI sets NODE_ENV before it reads this config.
      noxcturnalTransformWorker: process.env.NODE_ENV !== 'production',
    },
  };
  const file = process.env.GOOGLE_SERVICES_JSON?.trim() || config.android?.googleServicesFile;
  if (file && existsSync(resolve(__dirname, file))) {
    return { ...config, android: { ...config.android, googleServicesFile: file } };
  }
  if (config.android?.googleServicesFile) {
    console.warn(
      '[app.config] google-services.json is missing: this Android build has no push notifications.',
    );
  }
  const { googleServicesFile: _missing, ...android } = config.android ?? {};
  return { ...config, android };
};
