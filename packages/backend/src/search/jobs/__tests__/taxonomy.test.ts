import { describe, expect, it } from 'vitest';

import {
  JOB_REGIONS,
  annualizeSalary,
  descriptionFingerprint,
  employerKey,
  normalizeCountry,
  normalizeCurrency,
  normalizeEmploymentType,
  normalizeJobTitle,
  normalizeSalaryInterval,
  repairMojibake,
  resolveRegion,
  urlDomain,
} from '../taxonomy.js';

describe('job taxonomy', () => {
  it('maps schema.org employment codes and common spellings', () => {
    expect(normalizeEmploymentType('FULL_TIME')).toBe('full_time');
    expect(normalizeEmploymentType('Part-time')).toBe('part_time');
    expect(normalizeEmploymentType('CONTRACTOR')).toBe('contract');
    expect(normalizeEmploymentType('INTERN')).toBe('internship');
    expect(normalizeEmploymentType('PER_DIEM')).toBe('per_diem');
    expect(normalizeEmploymentType('permanent-ish')).toBeUndefined();
  });

  it('maps salary units and rejects anything else', () => {
    expect(normalizeSalaryInterval('YEAR')).toBe('year');
    expect(normalizeSalaryInterval('hourly')).toBe('hour');
    expect(normalizeSalaryInterval('per sprint')).toBeUndefined();
    expect(normalizeCurrency('eur')).toBe('EUR');
    expect(normalizeCurrency('euros')).toBeUndefined();
  });

  it('resolves countries by code and by name in both product languages', () => {
    expect(normalizeCountry('ES')).toBe('ES');
    expect(normalizeCountry('Spain')).toBe('ES');
    expect(normalizeCountry('España')).toBe('ES');
    expect(normalizeCountry('United Kingdom')).toBe('GB');
    expect(normalizeCountry('Alemania')).toBe('DE');
    expect(normalizeCountry('Atlantis')).toBeUndefined();
  });

  it('expands only the documented macro-regions', () => {
    expect(resolveRegion('Europe')).toEqual(JOB_REGIONS.europe);
    expect(resolveRegion('latam')).toEqual(JOB_REGIONS.latin_america);
    expect(resolveRegion('north_america')).toEqual(JOB_REGIONS.north_america);
    expect(resolveRegion('Europe')).toContain('ES');
    expect(resolveRegion('Europe')).not.toContain('US');
    expect(resolveRegion('Barcelona')).toBeUndefined();
  });

  it('annualizes with fixed working-time factors and never converts currency', () => {
    expect(annualizeSalary(50, 'hour')).toBe(104_000);
    expect(annualizeSalary(5_000, 'month')).toBe(60_000);
    expect(annualizeSalary(70_000, 'year')).toBe(70_000);
  });

  it('folds titles and employers without collapsing distinct employers', () => {
    expect(normalizeJobTitle('Senior  React-Native Engineer (Remote)')).toBe('senior react native engineer remote');
    expect(employerKey('Acme', 'https://www.acme.example/careers')).toBe('domain:acme.example');
    expect(employerKey('Acme Corp', undefined)).toBe('name:acme corp');
    expect(employerKey('Acme Corp', undefined)).not.toBe(employerKey('Acme Studio', undefined));
    expect(employerKey(undefined, undefined)).toBeUndefined();
    expect(urlDomain('https://WWW.Acme.example/x')).toBe('acme.example');
  });

  it('fingerprints only descriptions long enough to be distinctive', () => {
    const body = 'We are hiring a mobile engineer to build our client applications. '.repeat(5);
    expect(descriptionFingerprint(body)).toBe(descriptionFingerprint(`  ${body.toUpperCase()}  `));
    expect(descriptionFingerprint('Too short')).toBeUndefined();
    expect(descriptionFingerprint(undefined)).toBeUndefined();
  });

  it('repairs a source double-encoding its own UTF-8, measured live from RemoteOK', () => {
    // RemoteOK's /api returns this exact codepoint sequence for "we're"
    // (2026-09-16): the apostrophe's UTF-8 bytes E2 80 99 came back as three
    // separate Latin-1 codepoints instead of one right single quote.
    expect(repairMojibake('At ExtraHop, weâre on a mission')).toBe("At ExtraHop, we’re on a mission");
  });

  it('leaves correctly encoded text untouched, including real accents', () => {
    expect(repairMojibake('Ingénieur logiciel senior')).toBe('Ingénieur logiciel senior');
    expect(repairMojibake('Remote React Native role')).toBe('Remote React Native role');
    expect(repairMojibake('日本語のタイトル')).toBe('日本語のタイトル');
  });
});
