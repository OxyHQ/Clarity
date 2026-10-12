/**
 * The renditions Clarity keeps and serves for a remote image.
 *
 * Clarity never keeps a site's original image. Every image it fetches (a link
 * preview, an employer logo) is stored as ONE rendition: WebP, fitted inside
 * the ladder's `w1280` box, never enlarged — the same format, quality and sizes
 * Oxy's CDN gives post media and avatars (`@oxy.so/utils/image`). A smaller
 * rung a surface asks for (`?variant=w320`) is rendered from that rendition on
 * request. Before this, the cache held each site's original bytes, up to 5 MB
 * (235 KB on average, 4.3 GB in all on 2026-10-12), and served them unresized.
 *
 * Rendering is `Bun.Image`: the backend runs on Bun, whose static JPEG/PNG/WebP
 * codecs need no native module. It decodes JPEG, PNG, WebP, BMP and a GIF's
 * first frame; a source it cannot decode on Linux (AVIF, HEIC, TIFF, SVG)
 * yields no rendition and the image counts as missing. The fetch asks for the
 * formats it can read, so that is rare.
 */
import {
  CONTENT_IMAGE_VARIANTS,
  IMAGE_VARIANTS,
  IMAGE_VARIANT_QUALITY,
  isImageVariantName,
  type ContentImageVariantName,
} from '@oxy.so/utils/image';

/** The rung the cache stores; every smaller one is rendered from it. */
export const STORED_IMAGE_VARIANT: ContentImageVariantName = 'w1280';

/**
 * Bumped whenever {@link renderStoredImage} changes what it produces, so rows
 * rendered by an older pipeline (or holding an original, version 0) are
 * re-rendered — on their next read, and by the worker's sweep.
 */
export const STORED_IMAGE_RENDITION = 1;

/** The `Accept` a fetch sends: the formats `Bun.Image` can decode, best first. */
export const RENDERABLE_IMAGE_ACCEPT = 'image/webp,image/jpeg,image/png,image/gif;q=0.9';

/**
 * A decoded source larger than this many pixels is refused rather than
 * rendered — a decompression bomb costs the worker thread, not just bytes.
 * 40 MP covers any real preview image (an 8K frame is 33 MP).
 */
const MAX_SOURCE_PIXELS = 40_000_000;

export interface RenderedImage {
  contentType: 'image/webp';
  bytes: Buffer;
}

async function render(bytes: Uint8Array, width: number): Promise<RenderedImage | undefined> {
  try {
    const out = await new Bun.Image(bytes, { maxPixels: MAX_SOURCE_PIXELS })
      .resize(width, undefined, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: IMAGE_VARIANT_QUALITY })
      .buffer();
    return { contentType: 'image/webp', bytes: out };
  } catch {
    // Unsupported or corrupt input: no rendition rather than the original.
    return undefined;
  }
}

/** The rendition Clarity stores for fetched image bytes, or `undefined`. */
export function renderStoredImage(source: Uint8Array): Promise<RenderedImage | undefined> {
  return render(source, IMAGE_VARIANTS[STORED_IMAGE_VARIANT].width);
}

/**
 * The content rung a request asks for, or the stored one: an absent, unknown
 * or square (`w96`/`thumb`) variant gets the stored rendition, and so does any
 * rung at or above it, since nothing larger is kept.
 */
export function requestedImageVariant(value: unknown): ContentImageVariantName {
  if (!isImageVariantName(value)) return STORED_IMAGE_VARIANT;
  const rung = (CONTENT_IMAGE_VARIANTS as readonly string[]).includes(value)
    ? (value as ContentImageVariantName)
    : STORED_IMAGE_VARIANT;
  return IMAGE_VARIANTS[rung].width < IMAGE_VARIANTS[STORED_IMAGE_VARIANT].width
    ? rung
    : STORED_IMAGE_VARIANT;
}

/**
 * `stored` at `variant`. The stored rung is served as kept; a smaller one is
 * rendered from it (milliseconds, on Bun's worker thread). `undefined` only if
 * the stored rendition itself cannot be decoded.
 */
export async function imageAtVariant(
  stored: RenderedImage,
  variant: ContentImageVariantName,
): Promise<RenderedImage | undefined> {
  if (variant === STORED_IMAGE_VARIANT) return stored;
  return render(stored.bytes, IMAGE_VARIANTS[variant].width);
}
