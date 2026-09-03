/// <reference path="./.sst/platform/config.d.ts" />

/**
 * Clarity SST Infrastructure
 *
 * Manages:
 * - DigitalOcean App Platform API service
 *
 * PostgreSQL is supplied as a deployment secret. Valkey is managed externally.
 * The frontend deploys independently to Cloudflare Pages from GitHub Actions.
 *
 * Authentication is supplied by operator tooling from the untracked
 * ~/.config/oxy/tokens/digitalocean.token file; no token value belongs here.
 */

export default $config({
  app(input) {
    return {
      name: "clarity",
      home: "local",
      removal: input.stage === "production" ? "retain" : "remove",
      providers: {
        digitalocean: "4.63.0",
      },
    };
  },

  async run() {
    const isProd = $app.stage === "production";
    // -------------------------------------------------------
    // DigitalOcean App Platform
    // -------------------------------------------------------
    const app = new digitalocean.App("ClarityApp", {
      spec: {
        name: isProd ? "clarity-production" : `clarity-${$app.stage}`,
        region: "ams",

        // --- API service ---
        services: [
          {
            name: "clarity-api",
            github: {
              repo: "OxyHQ/Clarity",
              branch: isProd ? "master" : $app.stage,
              deployOnPush: true,
            },
            buildCommand: [
              "ELECTRON_SKIP_BINARY_DOWNLOAD=1",
              "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1",
              "bun run build:backend",
            ].join(" "),
            runCommand: "bun run start:backend",
            sourceDir: "/",
            environmentSlug: "node-js",
            instanceSizeSlug: isProd ? "apps-s-2vcpu-4gb" : "apps-s-1vcpu-1gb",
            instanceCount: isProd ? 2 : 1,
            httpPort: 8080,
            healthCheck: {
              httpPath: "/health/ready",
              initialDelaySeconds: 30,
              periodSeconds: 10,
              timeoutSeconds: 5,
              successThreshold: 1,
              failureThreshold: 3,
            },
            envs: [
              // Required product database URL
              { key: "DATABASE_URL", type: "SECRET" },
              { key: "REDIS_URL", value: "${db-valkey.DATABASE_URL}" },
              { key: "REDIS_CA_CERT", value: "${db-valkey.CA_CERT}" },
              // Product agent
              { key: "ALIA_API_URL", value: "https://api.alia.onl" },
              { key: "CLARITY_ALIA_AGENT_ID", value: "01a0646a-078f-7642-95ef-439952f4f3f9" },
              { key: "OXY_SERVICE_API_KEY", value: "oxy_dk_8c84c74a2656b8f5147d4d0b65fcd0e88c192ce64f465f78" },
              { key: "OXY_SERVICE_API_SECRET", type: "SECRET" },
              {
                key: "WEB_URL",
                value: isProd
                  ? "https://clarity.surf"
                  : `https://${$app.stage}.clarity.surf`,
              },
              // Stripe
              { key: "STRIPE_SECRET_KEY", type: "SECRET" },
              { key: "STRIPE_WEBHOOK_SECRET", type: "SECRET" },
              // Browser push
              { key: "VAPID_PUBLIC_KEY", type: "SECRET" },
              { key: "VAPID_PRIVATE_KEY", type: "SECRET" },
              { key: "VAPID_SUBJECT", value: "mailto:contact@clarity.surf" },
            ],
          },
        ],

        // --- Managed databases (shared, referenced by name) ---
        databases: [
          {
            name: "db-valkey",
            engine: "REDIS",
            version: "7",
            production: isProd,
            clusterName: "db-valkey-ams3-04785",
          },
        ],

        // --- Domains ---
        ...(isProd && {
          domains: [
            { domain: "api.clarity.surf", type: "PRIMARY", zone: "clarity.surf" },
          ],
        }),

        // --- Alerts ---
        alerts: [
          { rule: "DEPLOYMENT_FAILED" },
          { rule: "DOMAIN_FAILED" },
          { rule: "DEPLOYMENT_LIVE" },
        ],
      },
    });

    return {
      appUrl: app.liveUrl,
      stage: $app.stage,
    };
  },
});
