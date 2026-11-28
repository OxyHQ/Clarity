/**
 * Vectors as the text a `halfvec(1024)` column parses, as short as they can be
 * while storing exactly what the full float text stored.
 *
 * `halfvec` input parses each element as a float4 and rounds it to the
 * nearest half (round half to even). Kaana's float text was ~10 characters an
 * element — a batch of embeddings bound ~260 KB of it per statement. The half
 * an element becomes is computed here, the same two roundings, and written in
 * 5 significant digits: within a hundredth of a half's spacing of it, so the
 * column parses it back to that same half.
 */

const float32 = new Float32Array(1);
const bits32 = new Uint32Array(float32.buffer);

/** The half (as a number) a float4 rounds to, round half to even — pgvector's `Float4ToHalf`. */
export function toHalf(value: number): number {
  float32[0] = value;
  const bits = bits32[0];
  const sign = bits >>> 31 ? -1 : 1;
  const exponent = (bits >>> 23) & 0xff;
  const mantissa = bits & 0x7fffff;
  if (exponent === 0xff) return mantissa ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  const magnitude = Math.abs(float32[0]);
  if (magnitude >= 65520) return sign * Number.POSITIVE_INFINITY;
  // Halves are multiples of 2^(e-10) for magnitude in [2^e, 2^(e+1)), and of
  // 2^-24 below 2^-14 (subnormal).
  // The float4's own exponent: exact, unlike a logarithm near a power of two.
  const e = Math.max(exponent === 0 ? -126 : exponent - 127, -14);
  const step = 2 ** (e - 10);
  const scaled = magnitude / step;
  const floor = Math.floor(scaled);
  const remainder = scaled - floor;
  const rounded = remainder > 0.5 || (remainder === 0.5 && floor % 2 === 1) ? floor + 1 : floor;
  return sign * rounded * step;
}

/** `[x,y,…]` with each element at the half the column stores, in 5 significant digits. */
export function halfVectorText(values: readonly number[]): string {
  return `[${values.map((value) => Number(toHalf(value).toPrecision(5))).join(',')}]`;
}

/** The number a half's bits (IEEE 754 binary16) stand for. */
export function fromHalfBits(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 0x1f) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

/**
 * A `halfvec` from its binary form (`halfvec_send`): a big-endian int16
 * dimension, an unused int16, then each element's half, big-endian.
 */
export function halvesFromSend(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dimension = view.getInt16(0);
  if (bytes.byteLength !== 4 + 2 * dimension) throw new Error('A halfvec is the wrong length');
  return Array.from({ length: dimension }, (_, index) =>
    fromHalfBits(view.getUint16(4 + 2 * index)),
  );
}
