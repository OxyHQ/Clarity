import { describe, expect, it } from 'vitest';

import {
  COUNTRY_CODES, CURRENCY_CODES, JOB_EMPLOYMENT_TYPES, JOB_LIFECYCLE_STATUSES, JOB_SALARY_INTERVALS,
  JOB_WORKPLACE_TYPES, PLACE_KINDS, isCountryCode, isCurrencyCode,
} from '../src/vocabularies.js';

function expectSortedUnique(values: readonly string[]): void {
  expect(new Set(values).size).toBe(values.length);
  expect([...values].sort()).toEqual([...values]);
}

describe('closed vocabularies', () => {
  it('keeps every code list sorted and unique', () => {
    for (const list of [CURRENCY_CODES, COUNTRY_CODES, JOB_WORKPLACE_TYPES, JOB_EMPLOYMENT_TYPES, JOB_LIFECYCLE_STATUSES, PLACE_KINDS]) {
      expectSortedUnique(list);
    }
  });

  it('orders salary intervals by duration', () => {
    expect(new Set(JOB_SALARY_INTERVALS).size).toBe(JOB_SALARY_INTERVALS.length);
    expect(JOB_SALARY_INTERVALS).toEqual(['hour', 'day', 'week', 'month', 'year']);
  });

  it('lists only well-formed ISO codes', () => {
    for (const code of CURRENCY_CODES) expect(code).toMatch(/^[A-Z]{3}$/);
    for (const code of COUNTRY_CODES) expect(code).toMatch(/^[A-Z]{2}$/);
    expect(COUNTRY_CODES).toHaveLength(249);
  });

  it('accepts every currency as an Intl currency', () => {
    for (const currency of CURRENCY_CODES) {
      const formatter = new Intl.NumberFormat('en', { style: 'currency', currency });
      expect(formatter.resolvedOptions().currency).toBe(currency);
      expect(formatter.format(1)).not.toBe('');
    }
  });

  it('names every country through Intl.DisplayNames', () => {
    const names = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
    for (const country of COUNTRY_CODES) expect(names.of(country), country).toBeTruthy();
  });

  it('leaves out funds, metals, testing and withdrawn codes', () => {
    for (const code of ['XAU', 'XAG', 'XTS', 'XXX', 'XDR', 'BOV', 'CHE', 'USN', 'HRK', 'ANG', 'SLL', 'ZWL', 'BGN']) {
      expect(isCurrencyCode(code), code).toBe(false);
    }
    expect(isCurrencyCode('EUR')).toBe(true);
    expect(isCurrencyCode('eur')).toBe(false);
    expect(isCountryCode('ES')).toBe(true);
    expect(isCountryCode('XK')).toBe(false);
    expect(isCountryCode('UK')).toBe(false);
  });
});
