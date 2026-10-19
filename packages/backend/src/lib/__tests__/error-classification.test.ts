import { describe, expect, it } from 'vitest';

import { clientErrorStatus } from '../error-classification.js';

describe('clientErrorStatus', () => {
  it("keeps a middleware client error's own status", () => {
    // body-parser's errors are http-errors: `status`, `statusCode`, `expose`.
    expect(clientErrorStatus({ status: 413, statusCode: 413, expose: true })).toBe(413);
    expect(clientErrorStatus({ statusCode: 400, expose: true })).toBe(400);
  });

  it('leaves everything else to the 500 path', () => {
    expect(clientErrorStatus(new Error('boom'))).toBeUndefined();
    expect(clientErrorStatus({ status: 500, expose: true })).toBeUndefined();
    expect(clientErrorStatus({ status: 400, expose: false })).toBeUndefined();
    expect(clientErrorStatus(undefined)).toBeUndefined();
  });
});
