/**
 * Cloudflare Pages Worker -- SPA routing with proper MIME-type handling.
 *
 * Static files are served by the Pages asset pipeline with correct MIME types.
 * Only HTML-navigation requests fall back to /index.html.
 * Requests for missing static assets (old hashed filenames, etc.) receive a 404
 * instead of being silently rewritten to index.html, which would cause browsers
 * to reject the response due to MIME-type mismatch.
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Always try to serve the static asset first.
    const assetResponse = await env.ASSETS.fetch(request);

    // If the asset exists (not a 404), serve it with appropriate cache headers.
    if (assetResponse.status !== 404) {
      // Hashed assets under /_expo/static/ are content-addressed and can be
      // cached indefinitely. Everything else uses the default headers.
      if (pathname.startsWith("/_expo/static/")) {
        const headers = new Headers(assetResponse.headers);
        headers.set("Cache-Control", "public, max-age=31536000, immutable");
        return new Response(assetResponse.body, {
          status: assetResponse.status,
          headers,
        });
      }
      return assetResponse;
    }

    // The asset does not exist. Decide whether to serve the SPA shell.
    const extension = pathname.includes(".")
      ? pathname.slice(pathname.lastIndexOf(".")).toLowerCase()
      : "";

    // If the URL has a known static-asset extension, the file simply does not
    // exist (e.g., a stale hashed bundle). Return 404 -- never serve HTML here.
    if (STATIC_EXTENSIONS.has(extension)) {
      return new Response("Not Found", { status: 404 });
    }

    // For navigation requests (no extension, or unknown extension), serve
    // index.html so client-side routing can handle the path.
    const indexResponse = await env.ASSETS.fetch(
      new Request(new URL("/index.html", url.origin), request),
    );

    // Preserve the 200 status but ensure headers indicate HTML content.
    return new Response(indexResponse.body, {
      status: 200,
      headers: indexResponse.headers,
    });
  },
};
