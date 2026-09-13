import { observeEdgeRequest } from '@oxy.so/telemetry/edge';

/**
 * Clarity web Worker -- SPA routing with proper MIME-type handling.
 *
 * Moved here from `public/_worker.js` when the app left Cloudflare Pages for a
 * Worker. The behaviour it exists for is unchanged, and so is the reason:
 * `not_found_handling = "single-page-application"` answers ANY miss with
 * index.html, so a stale hashed bundle comes back as `text/html` and the
 * browser rejects it. This returns a real 404 for asset extensions instead.
 *
 * It has to keep running as the Worker `main` rather than becoming Pages
 * Advanced Mode again: `public/_worker.js` was only ever loaded by Pages, and
 * under a Worker that path is inert AND uploaded as a public asset.
 *
 * Runs before all assets so edge activity includes cached static responses.
 * Asset routing and headers remain owned by the ASSETS binding.
 */

const STATIC_EXTENSIONS = new Set([
  ".css",
  ".js",
  ".mjs",
  ".json",
  ".map",
  ".wasm",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".ico",
  ".webp",
  ".avif",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp3",
  ".mp4",
  ".webm",
  ".ogg",
  ".wav",
  ".pdf",
  ".xml",
  ".txt",
]);

function getExtension(pathname) {
  const lastDot = pathname.lastIndexOf(".");
  return lastDot === -1 ? "" : pathname.slice(lastDot).toLowerCase();
}

const assetWorker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const extension = getExtension(pathname);

    // Try the asset pipeline first.
    const assetResponse = await env.ASSETS.fetch(request);
    const contentType = assetResponse.headers.get("content-type") || "";

    // Detect when the platform returns an HTML fallback for a static-asset URL.
    // If the URL has a known static extension but the response is HTML, the
    // actual file doesn't exist (e.g., stale hashed bundle from a previous
    // deploy). Return a clean 404 instead of HTML with the wrong MIME type.
    if (STATIC_EXTENSIONS.has(extension) && contentType.includes("text/html")) {
      return new Response("Not Found", { status: 404 });
    }

    // For non-asset paths (SPA navigation routes), the platform's index.html
    // fallback is correct behavior. Return the response as-is.
    return assetResponse;
  },
};

export default {
  fetch(request, env, ctx) {
    return observeEdgeRequest({ service: 'clarity', request, env, ctx, next: () => assetWorker.fetch(request, env) });
  },
};
