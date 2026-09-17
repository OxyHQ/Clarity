import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import {
  parseAdmin1Codes, parseGazetteer, readZipEntry, subdivisionCode,
} from '../geonames.js';
import { foldPlaceName, geonamesIdFromUri, matchPlace, type PlaceCandidate } from '../resolve.js';

function city(id: string, name: string, countryCode: string, extra: Partial<PlaceCandidate> = {}): PlaceCandidate {
  return {
    id, kind: 'city', name, asciiName: name, countryCode, admin1Name: null,
    matchNames: [foldPlaceName(name)], population: 1000, ...extra,
  };
}

describe('GeoNames place references', () => {
  it('reads the id from www, sws and bare GeoNames URIs only', () => {
    expect(geonamesIdFromUri('https://www.geonames.org/3128760')).toBe('3128760');
    expect(geonamesIdFromUri('https://sws.geonames.org/3128760/')).toBe('3128760');
    expect(geonamesIdFromUri(['https://en.wikipedia.org/wiki/Barcelona', 'http://geonames.org/3128760/barcelona.html'])).toBe('3128760');
    expect(geonamesIdFromUri('https://evil.example/geonames.org/1')).toBeUndefined();
    expect(geonamesIdFromUri('3128760')).toBeUndefined();
  });
});

describe('matchPlace', () => {
  const candidates = [
    city('1', 'Springfield', 'US', { admin1Name: 'Illinois', population: 110_000 }),
    city('2', 'Springfield', 'US', { admin1Name: 'Missouri', population: 170_000 }),
    city('3', 'Munich', 'DE', { matchNames: ['munich', 'munchen', 'monaco di baviera'] }),
    city('4', 'Monaco', 'MC', { matchNames: ['monaco'] }),
    city('5', 'Barcelona', 'VE'),
    { ...city('6', 'Catalonia', 'ES'), kind: 'region' as const },
  ];

  it('resolves an exact name or an alternate name inside the stated country', () => {
    expect(matchPlace(candidates, { countryCode: 'DE', locality: 'München' })).toMatchObject({ status: 'resolved', place: { id: '3' } });
    expect(matchPlace(candidates, { countryCode: 'DE', locality: 'munich' })).toMatchObject({ status: 'resolved', place: { id: '3' } });
  });

  it('never crosses the stated country', () => {
    expect(matchPlace(candidates, { countryCode: 'ES', locality: 'Barcelona' })).toEqual({ status: 'not_found' });
  });

  it('uses a stated region only to break a tie, and otherwise reports ambiguity', () => {
    expect(matchPlace(candidates, { countryCode: 'US', locality: 'Springfield', region: 'Illinois' }))
      .toMatchObject({ status: 'resolved', place: { id: '1' } });
    const ambiguous = matchPlace(candidates, { countryCode: 'US', locality: 'Springfield' });
    expect(ambiguous.status).toBe('ambiguous');
    expect(ambiguous.status === 'ambiguous' && ambiguous.candidates.map((place) => place.id)).toEqual(['2', '1']);
  });

  it('does not resolve a locality to a region', () => {
    expect(matchPlace(candidates, { countryCode: 'ES', locality: 'Catalonia' })).toEqual({ status: 'not_found' });
  });
});

describe('GeoNames dump parsing', () => {
  const admin1 = parseAdmin1Codes([
    'ES.56\tCatalonia\tCatalonia\t3336901',
    'US.CA\tCalifornia\tCalifornia\t5332921',
    'XK.01\tPristina\tPristina\t786712',
    'broken line',
  ].join('\n'));

  const row = (columns: Record<number, string>) => Array.from({ length: 19 }, (_, index) => columns[index] ?? '').join('\t');
  const cities = [
    row({ 0: '3128760', 1: 'Barcelona', 2: 'Barcelona', 3: 'BCN,Barcelone,Barcellona,https://en.wikipedia.org/wiki/Barcelona', 4: '41.38879', 5: '2.15899', 6: 'P', 7: 'PPLA', 8: 'ES', 10: '56', 14: '1686208', 17: 'Europe/Madrid', 18: '2024-01-10' }),
    row({ 0: '5391959', 1: 'San Francisco', 2: 'San Francisco', 6: 'P', 7: 'PPLA2', 8: 'US', 10: 'CA', 14: '827526', 17: 'America/Los_Angeles', 18: '2024-02-01' }),
    row({ 0: '786714', 1: 'Pristina', 2: 'Pristina', 6: 'P', 7: 'PPLC', 8: 'XK', 10: '01', 14: '161751' }),
    row({ 0: '1', 1: 'Not a place', 2: 'Not a place', 6: 'H', 8: 'ES' }),
  ].join('\r\n');

  it('builds regions and cities, and skips countries outside COUNTRY_CODES', () => {
    const { records, skippedCountries } = parseGazetteer(cities, admin1);
    expect(records.map((record) => `${record.kind}:${record.id}`)).toEqual([
      'region:3336901', 'region:5332921', 'city:3128760', 'city:5391959',
    ]);
    expect(skippedCountries.get('XK')).toBe(2);
    const barcelona = records.find((record) => record.id === '3128760');
    expect(barcelona).toMatchObject({
      name: 'Barcelona', searchName: 'barcelona', countryCode: 'ES', admin1Code: '56', admin1Name: 'Catalonia',
      subdivisionCode: null, population: 1686208, latitude: 41.38879, timezone: 'Europe/Madrid',
    });
    expect(barcelona?.matchNames).toEqual(['barcelona', 'bcn', 'barcelone', 'barcellona']);
    expect(barcelona?.sourceModifiedAt?.toISOString()).toBe('2024-01-10T00:00:00.000Z');
    expect(records.find((record) => record.id === '5391959')?.subdivisionCode).toBe('US-CA');
  });

  it('derives an ISO 3166-2 code only where GeoNames already uses it', () => {
    expect(subdivisionCode('US', 'NY')).toBe('US-NY');
    expect(subdivisionCode('GB', 'ENG')).toBe('GB-ENG');
    expect(subdivisionCode('ES', '56')).toBeNull();
    expect(subdivisionCode('DE', '02')).toBeNull();
  });

  it('extracts stored and deflated ZIP entries', () => {
    const zip = (name: string, content: Buffer, method: 0 | 8): Buffer => {
      const data = method === 8 ? deflateRawSync(content) : content;
      const fileName = Buffer.from(name);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(method, 8);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(content.length, 22);
      local.writeUInt16LE(fileName.length, 26);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(method, 10);
      central.writeUInt32LE(data.length, 20);
      central.writeUInt32LE(content.length, 24);
      central.writeUInt16LE(fileName.length, 28);
      central.writeUInt32LE(0, 42);
      const centralOffset = local.length + fileName.length + data.length;
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(1, 8);
      end.writeUInt16LE(1, 10);
      end.writeUInt32LE(central.length + fileName.length, 12);
      end.writeUInt32LE(centralOffset, 16);
      return Buffer.concat([local, fileName, data, central, fileName, end]);
    };
    const content = Buffer.from('3128760\tBarcelona\n'.repeat(50));
    expect(readZipEntry(zip('cities15000.txt', content, 8), 'cities15000.txt').equals(content)).toBe(true);
    expect(readZipEntry(zip('cities15000.txt', content, 0), 'cities15000.txt').equals(content)).toBe(true);
    expect(() => readZipEntry(zip('other.txt', content, 0), 'cities15000.txt')).toThrow('not found');
    expect(() => readZipEntry(Buffer.from('not a zip at all, definitely not'), 'x')).toThrow('Not a ZIP');
  });
});
