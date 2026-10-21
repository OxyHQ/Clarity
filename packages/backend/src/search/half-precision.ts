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
