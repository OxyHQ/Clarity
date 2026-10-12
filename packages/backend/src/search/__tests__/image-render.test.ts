import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import {
  STORED_IMAGE_VARIANT,
  imageAtVariant,
  renderStoredImage,
  requestedImageVariant,
} from '../image-render.js';

/*
 * Runs under vitest AND `bun test` (see the `test:bun` script). Rendering is
 * `Bun.Image`, which only exists on Bun, so those cases run there; the variant
 * mapping is plain logic and runs under both.
 */
const onBun = typeof Bun !== 'undefined';
const renders = onBun ? describe : describe.skip;

/** A real PNG of `width`×`height` noisy pixels, encoded here so no fixture is committed. */
function png(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(Bun.hash.crc32(body) >>> 0, 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const rows = Buffer.alloc((width * 3 + 1) * height);
  let seed = 7;
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width * 3; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      rows[row + 1 + x] = (x + y + (seed >> 24)) & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', new Uint8Array()),
  ]);
}

async function sizeOf(bytes: Uint8Array) {
  return new Bun.Image(bytes).metadata();
}

/** The rendition, failing the test if there is none. */
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected a rendition');
  return value;
}

renders('rendering on Bun', () => {
  it('stores a WebP fitted inside the w1280 rung, never the source', async () => {
    const source = png(2400, 1600);
    const stored = present(await renderStoredImage(source));

    expect(stored.contentType).toBe('image/webp');
    expect(await sizeOf(stored.bytes)).toEqual({ width: 1280, height: 853, format: 'webp' });
    expect(stored.bytes.length).toBeLessThan(source.length);
  });

  it('never enlarges a small image', async () => {
    const stored = present(await renderStoredImage(png(200, 100)));
    expect(await sizeOf(stored.bytes)).toEqual({ width: 200, height: 100, format: 'webp' });
  });

  it('renders a smaller rung from the stored rendition', async () => {
    const stored = present(await renderStoredImage(png(2400, 1600)));

    const small = present(await imageAtVariant(stored, 'w320'));
    expect(await sizeOf(small.bytes)).toEqual({ width: 320, height: 213, format: 'webp' });
    expect(await imageAtVariant(stored, STORED_IMAGE_VARIANT)).toBe(stored);
  });

  it('keeps nothing for bytes that are not a decodable image', async () => {
    expect(await renderStoredImage(Buffer.from('<html>not an image</html>'))).toBeUndefined();
  });
});

describe('requestedImageVariant', () => {
  it('honours a content rung below the stored one', () => {
    expect(requestedImageVariant('w320')).toBe('w320');
    expect(requestedImageVariant('w640')).toBe('w640');
  });

  it('serves the stored rendition for anything else', () => {
    expect(requestedImageVariant(undefined)).toBe('w1280');
    expect(requestedImageVariant('w2048')).toBe('w1280');
    expect(requestedImageVariant('thumb')).toBe('w1280');
    expect(requestedImageVariant('../../etc')).toBe('w1280');
    expect(requestedImageVariant(['w320', 'w640'])).toBe('w1280');
  });
});
