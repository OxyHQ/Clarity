import { describe, expect, it } from 'vitest';

import { evaluateRuntimeReadiness } from '../runtime-readiness.js';

describe('runtime cutover readiness', () => {
  it('opens for a reconciled cutover', () => {
    expect(evaluateRuntimeReadiness({ status: 'cutover' })).toEqual({ ready: true });
  });

  it('opens for a deployment attested as never having had prior data, same as a real cutover', () => {
    expect(evaluateRuntimeReadiness({ status: 'fresh_install' })).toEqual({ ready: true });
  });

  it.each([[undefined], [{ status: 'reconciled' }], [{ status: 'unknown' }]] as const)(
    'stays closed until the snapshot is attested (%j)',
    (row) => {
      expect(evaluateRuntimeReadiness(row)).toEqual({
        ready: false,
        reason: 'postgres_cutover_unattested',
      });
    },
  );
});
