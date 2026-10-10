/**
 * Narrows a value a test needs to exist. Unlike `!`, a missing value fails the
 * test with a message naming it instead of a TypeError further on.
 */
export function defined<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what} to be defined`);
  return value;
}
