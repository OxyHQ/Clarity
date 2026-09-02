/// <reference path="./.sst/platform/config.d.ts" />

/**
 * Clarity SST Infrastructure
 *
 * Manages:
 * - DigitalOcean App Platform (API service + static frontend)
 * - DigitalOcean Spaces bucket (file storage)
 *
 * PostgreSQL is supplied as a deployment secret. Valkey is managed externally.
 *
 * Auth:
 *   export DIGITALOCEAN_TOKEN=dop_v1_...
 *   export CLOUDFLARE_API_TOKEN=...
 */

export default $config({
  app(input) {
    return {
      name: "clarity",
      home: "local",
      removal: input.stage === "production" ? "retain" : "remove",
      providers: {
        digitalocean: "4.63.0",
        cloudflare: "6.14.0",
      },
    };
  },

  async run() {
    const isProd = $app.stage === "production";
    const region = "ams3";

    // -------------------------------------------------------
    // DigitalOcean Spaces bucket for file uploads
    // -------------------------------------------------------
    const bucket = new digitalocean.SpacesBucket("ClarityBucket", {
      name: isProd ? "bucket-clarity" : `bucket-clarity-${$app.stage}`,
      region,
      acl: "private",
    });

    // CORS for the bucket
    new digitalocean.SpacesBucketCorsConfiguration("ClarityBucketCors", {
      bucket: bucket.id,
      region,
      corsRules: [
        {
          allowedHeaders: ["*"],
          allowedMethods: ["GET", "PUT", "POST", "DELETE", "HEAD"],
          allowedOrigins: isProd
            ? ["https://clarity.surf", "https://api.clarity.surf"]
            : ["*"],
          maxAgeSeconds: 3600,
        },
      ],
    });

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
              { key: "CLARITY_ALIA_AGENT_ID", type: "SECRET" },
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

        // --- Static frontend ---
        staticSites: [
          {
            name: "clarity-app",
            github: {
              repo: "OxyHQ/Clarity",
              branch: isProd ? "master" : $app.stage,
              deployOnPush: true,
            },
            buildCommand: [
              "ELECTRON_SKIP_BINARY_DOWNLOAD=1",
              "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1",
              "bun run build:frontend",
            ].join(" "),
            sourceDir: "/",
            environmentSlug: "node-js",
            outputDir: "packages/frontend/dist",
            catchallDocument: "index.html",
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
            { domain: "clarity.surf", type: "PRIMARY", zone: "clarity.surf" },
            { domain: "api.clarity.surf", type: "ALIAS", zone: "clarity.surf" },
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
      bucketName: bucket.name,
      bucketUrn: bucket.urn,
      stage: $app.stage,
    };
  },
});
