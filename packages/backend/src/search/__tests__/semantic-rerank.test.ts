import { describe, expect, it } from 'vitest';

import { halvesFromSend, toHalf } from '../half-precision.js';
import {
  codeDistance,
  int8Distance,
  int8Vector,
  semanticRerank,
  storesChunkVectors,
  vectorNorm,
} from '../semantic-rerank.js';

/**
 * The reranks of docs/adr/0001-search-storage-diet.md: a chunk's int8 vector or
 * binary code against the query's float vector, and the flags that pick one
 * and stop the half-precision writes.
 */
const D = 1024;

/** `varbit_send(binary_quantize(vector)::bit(1024))`. */
function codeOf(vector: readonly number[]): Uint8Array {
  const code = new Uint8Array(4 + D / 8);
  new DataView(code.buffer).setInt32(0, D);
  vector.forEach((value, index) => {
    if (value > 0) code[4 + (index >> 3)] |= 1 << (7 - (index & 7));
  });
  return code;
}

const seeded = (seed: number) => {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648 - 0.5;
  };
};

describe('codeDistance', () => {
  it('reads the bits as varbit_send sends them, first dimension in the high bit', () => {
    const query = Array.from({ length: D }, () => 0);
    query[0] = 1;
    const first = codeOf(query);
    expect(first[4]).toBe(0b1000_0000);
    // The only dimension the query weighs agrees in sign: the code scores the
    // query's norm over √D; disagreeing scores its opposite.
    expect(codeDistance(query, 1, first)).toBeCloseTo(1 - 1 / 32, 10);
    expect(codeDistance(query, 1, codeOf(query.map((v) => -v)))).toBeCloseTo(1 + 1 / 32, 10);
  });

  it('orders chunks as their cosine distance does, for chunks far apart', () => {
    const random = seeded(7);
    const query = Array.from({ length: D }, random);
    const norm = vectorNorm(query);
    // A chunk near the query, one unrelated, one opposite.
    const near = query.map((value) => value + random() * 0.2);
    const unrelated = Array.from({ length: D }, random);
    const opposite = query.map((value) => -value);
    const distances = [near, unrelated, opposite].map((chunk) =>
      codeDistance(query, norm, codeOf(chunk)),
    );
    expect(distances[0]).toBeLessThan(distances[1]);
    expect(distances[1]).toBeLessThan(distances[2]);
  });

  it('refuses a code shorter than the vector', () => {
    expect(() => codeDistance([1], 1, new Uint8Array(8))).toThrow();
  });
});

describe('int8 vectors', () => {
  it('scales the largest element to ±127 and keeps the cosine distance', () => {
    const random = seeded(11);
    const vector = Array.from({ length: D }, random);
    const bytes = int8Vector(vector);
    const signed = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(Math.max(...Array.from(signed, Math.abs))).toBe(127);
    const query = Array.from({ length: D }, random);
    const norm = vectorNorm(query);
    let dot = 0;
    for (let i = 0; i < D; i++) dot += query[i] * vector[i];
    const exact = 1 - dot / (norm * vectorNorm(vector));
    expect(Math.abs(int8Distance(query, norm, bytes) - exact)).toBeLessThan(0.01);
    // The nearest of two is the nearest at int8 too.
    const near = query.map((value) => value + random() * 0.3);
    expect(int8Distance(query, norm, int8Vector(near))).toBeLessThan(
      int8Distance(query, norm, bytes),
    );
  });

  it('stores a zero vector as zeros, and refuses the wrong width', () => {
    expect(int8Vector(new Array(D).fill(0)).every((byte) => byte === 0)).toBe(true);
    expect(() => int8Vector([1, 2, 3])).toThrow();
    expect(() => int8Distance([1], 1, new Uint8Array(3))).toThrow();
  });

  it('reads a halfvec as halfvec_send sends it', () => {
    const values = [1, -2, 0.5, 65504, 2 ** -24, 0];
    const bytes = new Uint8Array(4 + 2 * values.length);
    const view = new DataView(bytes.buffer);
    view.setInt16(0, values.length);
    // 1, -2, 0.5, the largest half, the smallest subnormal, zero.
    [0x3c00, 0xc000, 0x3800, 0x7bff, 0x0001, 0x0000].forEach((bits, i) =>
      view.setUint16(4 + 2 * i, bits),
    );
    expect(halvesFromSend(bytes)).toEqual(values.map(toHalf));
    expect(() => halvesFromSend(bytes.subarray(0, 6))).toThrow();
  });
});

describe('the rerank flags', () => {
  it('reranks by vectors unless the deployment says int8 or codes', () => {
    expect(semanticRerank({})).toBe('vectors');
    expect(semanticRerank({ CLARITY_SEMANTIC_RERANK: 'anything' })).toBe('vectors');
    expect(semanticRerank({ CLARITY_SEMANTIC_RERANK: 'int8' })).toBe('int8');
    expect(semanticRerank({ CLARITY_SEMANTIC_RERANK: 'codes' })).toBe('codes');
  });

  it('stops writing vectors only while the rerank reads none', () => {
    expect(storesChunkVectors({})).toBe(true);
    expect(storesChunkVectors({ CLARITY_STORE_CHUNK_VECTORS: 'false' })).toBe(true);
    expect(storesChunkVectors({ CLARITY_SEMANTIC_RERANK: 'codes' })).toBe(true);
    for (const rerank of ['int8', 'codes'])
      expect(
        storesChunkVectors({
          CLARITY_SEMANTIC_RERANK: rerank,
          CLARITY_STORE_CHUNK_VECTORS: 'false',
        }),
      ).toBe(false);
  });
});
