import { describe, expect, it } from 'vitest';
import { createOrganizationSchema } from '@oxy.so/contracts';
import { parseOrganizationDraft } from '../organization-draft';

describe('parseOrganizationDraft', () => {
  const valid = {
    name: ' Example ',
    organizationType: 'business' as const,
    websiteUrl: '',
    countryCode: '',
  };

  it('normalizes the draft before checking the shared contract', () => {
    expect(
      parseOrganizationDraft({
        ...valid,
        websiteUrl: ' https://example.com ',
        countryCode: ' es ',
      }),
    ).toEqual({
      name: 'Example',
      organizationType: 'business',
      websiteUrl: 'https://example.com',
      countryCode: 'ES',
    });
    expect(parseOrganizationDraft(valid)).toMatchObject({ websiteUrl: null, countryCode: null });
  });

  it('rejects invalid fields before sending a create request', () => {
    expect(parseOrganizationDraft({ ...valid, name: ' ' })).toBeNull();
    expect(parseOrganizationDraft({ ...valid, websiteUrl: 'not a url' })).toBeNull();
    expect(parseOrganizationDraft({ ...valid, countryCode: 'USA' })).toBeNull();
  });

  it('matches the server schema for normalized drafts', () => {
    for (const name of ['', 'Example', 'x'.repeat(201)]) {
      for (const websiteUrl of ['', 'https://example.com', 'ftp://example.com', 'invalid']) {
        for (const countryCode of ['', 'ES', 'USA']) {
          const draft = { ...valid, name, websiteUrl, countryCode };
          const normalized = {
            name: name.trim(),
            organizationType: draft.organizationType,
            websiteUrl: websiteUrl.trim() || null,
            countryCode: countryCode.trim().toUpperCase() || null,
          };
          expect(parseOrganizationDraft(draft) !== null).toBe(
            createOrganizationSchema.safeParse(normalized).success,
          );
        }
      }
    }
  });
});
