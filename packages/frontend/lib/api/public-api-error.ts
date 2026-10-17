/**
 * A failed call to one of Clarity's public surfaces, as the backend answered it
 * (`{ error: { code, message, requestId } }`).
 *
 * The status and code are kept rather than folded into a message because a
 * surface's next sentence depends on them: a product that is GONE (410), one
 * that never existed (404) and an upstream that is briefly down (503) are three
 * different things to tell a person, and only the last is worth a retry.
 *
 * Pure: nothing here loads React Native or the app config, so `lib/` helpers that
 * read an error stay testable.
 */
export class PublicApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly requestId: string | undefined;

  constructor(input: { status: number; code?: string; message?: string; requestId?: string }) {
    super(input.message ?? `Clarity request failed with ${input.status}`);
    this.name = 'PublicApiError';
    this.status = input.status;
    this.code = input.code;
    this.requestId = input.requestId;
  }
}

/** The HTTP status of a failed public call, or `undefined` for a network failure. */
export function publicApiStatus(error: unknown): number | undefined {
  return error instanceof PublicApiError ? error.status : undefined;
}
