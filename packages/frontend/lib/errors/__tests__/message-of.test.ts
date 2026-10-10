import { describe, expect, it } from 'vitest';
import { messageOf } from '../message-of';

describe('messageOf', () => {
  it('reads the message of an Error or an error-shaped object', () => {
    expect(messageOf(new Error('card declined'))).toBe('card declined');
    expect(messageOf({ message: 'portal unavailable', status: 503 })).toBe('portal unavailable');
  });

  it('returns undefined instead of throwing for anything else', () => {
    // `(error as any).message` threw on null and undefined.
    for (const thrown of [null, undefined, 'text', 42, {}, { message: 7 }]) {
      expect(messageOf(thrown)).toBeUndefined();
    }
  });
});
