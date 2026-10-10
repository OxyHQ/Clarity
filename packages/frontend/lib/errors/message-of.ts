/**
 * The `message` of whatever a catch block received, if it has a string one.
 * Unlike `(error as any).message`, it does not throw when null or a
 * primitive was thrown.
 */
export function messageOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const { message } = error;
    if (typeof message === 'string') return message;
  }
  return undefined;
}
