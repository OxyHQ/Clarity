/**
 * `app.json`, plus the one thing it cannot say: where Firebase's
 * `google-services.json` (Android push) comes from. The file is not in the
 * repository (it is gitignored), so an EAS build never receives it from the
 * project archive and `expo prebuild` used to fail copying it.
 *
 * An EAS file environment variable `GOOGLE_SERVICES_JSON` provides it on EAS;
 * a local build may use the ignored `./google-services.json`. With neither,
 * the Android app still builds, without FCM push delivery.
 */
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');

module.exports = ({ config }) => {
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
