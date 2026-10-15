import { describe, expect, it } from 'vitest';
import type { Supervision } from '@oxy.so/contracts';
import { claritySurfaceAccess } from '../supervised-surfaces';

const adult = {
  isAuthenticated: true,
  isAuthResolved: true,
  accountId: 'adult',
  kind: 'personal',
  state: { self: null },
};
const child: Supervision = {
  childAccountId: 'child',
  guardianAccountId: 'guardian',
  status: 'active',
  consentVersion: '1',
  policyVersion: '2',
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('Clarity supervised surface availability', () => {
  it('preserves signed-out and fresh adult sessions', () => {
    expect(
      claritySurfaceAccess({ isAuthenticated: false, isAuthResolved: true, state: undefined }),
    ).toBe('ordinary');
    expect(claritySurfaceAccess({ ...adult, isAuthResolved: false })).toBe('pending');
    expect(claritySurfaceAccess(adult)).toBe('ordinary');
    expect(claritySurfaceAccess({ ...adult, kind: 'organization', state: undefined })).toBe(
      'ordinary',
    );
  });
  it('hides cached product content while an account/session transition or outage is unresolved', () => {
    expect(claritySurfaceAccess({ ...adult, isAuthResolved: false })).toBe('pending');
    expect(claritySurfaceAccess(adult)).toBe('ordinary');
    for (const accountId of ['adult', 'child']) {
      expect(claritySurfaceAccess({ ...adult, accountId, state: undefined })).toBe('pending');
    }
    expect(claritySurfaceAccess({ ...adult, isAuthenticated: false })).toBe('pending');
    expect(claritySurfaceAccess({ ...adult, kind: undefined })).toBe('pending');
  });
  it('limits active and orphaned supervision and returns only after a fresh ended decision', () => {
    expect(claritySurfaceAccess({ ...adult, state: { self: child } })).toBe('limited');
    expect(
      claritySurfaceAccess({ ...adult, state: { self: { ...child, status: 'orphaned' } } }),
    ).toBe('limited');
    expect(claritySurfaceAccess({ ...adult, state: undefined })).toBe('pending');
    expect(claritySurfaceAccess({ ...adult, state: { self: { ...child, status: 'ended' } } })).toBe(
      'ordinary',
    );
  });
});
