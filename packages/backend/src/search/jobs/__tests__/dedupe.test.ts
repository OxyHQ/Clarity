import { describe, expect, it } from 'vitest';

import { canonicalSourceRank, jobClusterSignatures, normalizeListingUrl } from '../dedupe.js';

const base = {
  employerKey: 'domain:acme.example',
  normalizedTitle: 'senior react native engineer',
  descriptionFingerprint: 'f'.repeat(64),
  locations: [{ countryCode: 'ES', locality: 'Barcelona', raw: 'Barcelona, Spain' }],
};

function signatures(job: Parameters<typeof jobClusterSignatures>[0]): string[] {
  return jobClusterSignatures(job).map((signature) => signature.value);
}

describe('job canonicalization signatures', () => {
  it('strips tracking noise so syndicated links compare equal', () => {
    expect(normalizeListingUrl('https://WWW.Acme.example/jobs/1/?utm_source=board&ref=x#apply'))
      .toBe('acme.example/jobs/1');
    expect(normalizeListingUrl('http://acme.example/jobs/1?b=2&a=1'))
      .toBe(normalizeListingUrl('https://acme.example/jobs/1?a=1&b=2'));
    expect(normalizeListingUrl('not a url')).toBeUndefined();
  });

  it('groups the same requisition published on two hosts', () => {
    const careers = signatures({ ...base, identifier: 'REQ-1042', canonicalUrl: 'https://acme.example/jobs/1' });
    const ats = signatures({ ...base, identifier: 'REQ-1042', canonicalUrl: 'https://boards.greenhouse.io/acme/jobs/1042' });
    expect(careers.filter((signature) => ats.includes(signature))).toContain('domain:acme.example|id|req-1042');
  });

  it('treats gh_jid as tracking noise, not part of listing identity', () => {
    // Measured Greenhouse URL shapes (2026-09-09, OxyHQ/Clarity#19): the same
    // posting's id appears in the path on every shape, and `gh_jid` merely
    // repeats it when a company fronts the board with its own careers domain.
    expect(normalizeListingUrl('https://boards.greenhouse.io/acme/jobs/1042?gh_jid=1042'))
      .toBe(normalizeListingUrl('https://boards.greenhouse.io/acme/jobs/1042'));
  });

  it('groups an employer-fronted Greenhouse URL with its ATS-hosted twin by requisition id', () => {
    // The employer-fronted shape can carry a non-numeric path slug, so the
    // shared `identifier` — not the URL — is what has to carry the join.
    const fronted = signatures({
      ...base, identifier: '4242',
      canonicalUrl: 'https://acme.example/positions/senior-engineer?gh_jid=4242',
    });
    const atsHosted = signatures({
      ...base, identifier: '4242',
      canonicalUrl: 'https://job-boards.greenhouse.io/acme/jobs/4242',
    });
    expect(fronted.some((signature) => atsHosted.includes(signature))).toBe(true);
  });

  it('groups a board copy that links to the same apply URL', () => {
    const original = signatures({ ...base, canonicalUrl: 'https://acme.example/jobs/1' });
    const board = signatures({
      ...base,
      canonicalUrl: 'https://board.example/listing/99',
      applyUrl: 'https://acme.example/jobs/1?utm_source=board',
    });
    expect(original.some((signature) => board.includes(signature))).toBe(true);
  });

  it('never groups two listings on a similar title alone', () => {
    const left = signatures({
      employerKey: 'domain:acme.example',
      normalizedTitle: 'senior react native engineer',
      canonicalUrl: 'https://acme.example/jobs/1',
      locations: [{ countryCode: 'ES', raw: 'Barcelona' }],
    });
    const right = signatures({
      employerKey: 'domain:other.example',
      normalizedTitle: 'senior react native engineer',
      canonicalUrl: 'https://other.example/jobs/9',
      locations: [{ countryCode: 'ES', raw: 'Barcelona' }],
    });
    expect(left.filter((signature) => right.includes(signature))).toEqual([]);
  });

  it('does not group same-title listings from one employer when bodies differ', () => {
    const junior = signatures({ ...base, descriptionFingerprint: 'a'.repeat(64), canonicalUrl: 'https://acme.example/jobs/1' });
    const senior = signatures({ ...base, descriptionFingerprint: 'b'.repeat(64), canonicalUrl: 'https://acme.example/jobs/2' });
    expect(junior.filter((signature) => senior.includes(signature))).toEqual([]);
  });

  it('prefers the employer domain, then an ATS, over any other source type', () => {
    const employer = canonicalSourceRank({ canonicalUrl: 'https://acme.example/jobs/1', employerDomain: 'acme.example', sourceType: 'web' });
    const ats = canonicalSourceRank({ canonicalUrl: 'https://boards.greenhouse.io/acme/1', employerDomain: 'acme.example', sourceType: 'web' });
    const verified = canonicalSourceRank({ canonicalUrl: 'https://careers.example/1', employerDomain: 'acme.example', sourceType: 'verified_site' });
    const firstParty = canonicalSourceRank({ canonicalUrl: 'https://mention.earth/jobs/1', employerDomain: 'acme.example', sourceType: 'first_party' });
    expect(employer).toBeLessThan(ats);
    expect(ats).toBeLessThan(verified);
    expect(verified).toBeLessThan(firstParty);
  });
});
