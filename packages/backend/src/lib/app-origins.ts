/**
 * The browser origins Clarity's own surfaces admit, for HTTP (`createOxyCors`)
 * and Socket.IO (`createOxySocketCors`) alike. The HTTPS Oxy origin family
 * (`oxy.so` and its one-label subdomains) is admitted by the SDK on top.
 *
 * A native app sends no `Origin` and needs no entry; a custom scheme
 * (`exp://`) has no origin to match and the SDK refuses one.
 */
const DEV_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:8081',
  'http://10.0.2.2:8081',
];

/** Clarity's web app. */
export const CLARITY_APP_ORIGINS: string[] = [
  ...(process.env.WEB_URL ? [process.env.WEB_URL] : []),
  'https://clarity.surf',
  ...DEV_ORIGINS,
];

/** Experience is also read and edited from Mention's web app. */
export const EXPERIENCE_APP_ORIGINS: string[] = [
  ...CLARITY_APP_ORIGINS,
  'https://mention.earth',
  'http://localhost:8082',
];
