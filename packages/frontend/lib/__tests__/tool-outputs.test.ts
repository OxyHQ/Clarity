import { describe, expect, it } from 'vitest';

import {
  jobOf,
  jobsOfSearch,
  quotesOf,
  sourceOfDocument,
  sourcesOfSearch,
  storiesOfNews,
  unshownCount,
} from '../tool-outputs';

const job = {
  id: 'job-1',
  title: 'React Native engineer',
  employer: { name: 'Oxy' },
  source: { domain: 'oxy.so' },
  locations: [],
  employmentTypes: ['full_time'],
  otherSources: [],
  snippet: 'Build Clarity.',
};

describe('sourcesOfSearch', () => {
  it('reads POST /v1/search results as links, in rank order', () => {
    expect(
      sourcesOfSearch({
        data: [
          {
            canonicalUrl: 'https://www.example.com/a',
            title: 'A page',
            snippet: 'The excerpt',
            score: 1,
          },
          { canonicalUrl: 'https://example.org/b', description: 'Only a description', score: 0 },
        ],
        mode: 'hybrid',
      }),
    ).toEqual([
      {
        title: 'A page',
        url: 'https://www.example.com/a',
        snippet: 'The excerpt',
        domain: 'example.com',
      },
      {
        title: 'example.org',
        url: 'https://example.org/b',
        snippet: 'Only a description',
        domain: 'example.org',
      },
    ]);
  });

  it('draws nothing for an output that is not a search answer', () => {
    expect(sourcesOfSearch(undefined)).toEqual([]);
    expect(sourcesOfSearch({ data: 'nope' })).toEqual([]);
    expect(sourcesOfSearch({ data: [{ title: 'no url' }] })).toEqual([]);
  });

  it('bounds an excerpt to what a row shows', () => {
    const [source] = sourcesOfSearch({
      data: [{ canonicalUrl: 'https://a.example/', snippet: 'x'.repeat(500) }],
    });
    expect(source?.snippet).toHaveLength(200);
  });
});

describe('sourceOfDocument', () => {
  it('reads one public document, falling back to its domain for a title', () => {
    expect(sourceOfDocument({ canonicalUrl: 'https://docs.example.com/x' })).toEqual({
      title: 'docs.example.com',
      url: 'https://docs.example.com/x',
      snippet: '',
      domain: 'docs.example.com',
    });
    expect(sourceOfDocument({ error: { code: 'document_not_found' } })).toBeNull();
  });
});

describe('storiesOfNews', () => {
  it('keeps the stories a card can draw', () => {
    const story = { id: 's1', title: 'Story', articles: [], sourceCount: 2 };
    expect(storiesOfNews({ data: [story, { id: 's2' }, null] })).toEqual([story]);
    expect(storiesOfNews({})).toEqual([]);
  });
});

describe('jobsOfSearch and jobOf', () => {
  it('keeps complete postings only', () => {
    expect(jobsOfSearch({ data: [job, { ...job, employer: {} }], mode: 'hybrid' })).toEqual([job]);
    expect(jobOf(job)).toEqual(job);
    expect(jobOf({ error: { code: 'job_not_found' } })).toBeNull();
  });
});

describe('quotesOf', () => {
  it('keeps every requested asset, quoted or not', () => {
    const quoted = { requested: 'bitcoin', status: 'quoted', quote: { price: 1 } };
    const unavailable = {
      requested: 'faircoin',
      status: 'unavailable',
      error: { code: 'quote_unavailable', message: 'down' },
    };
    expect(
      quotesOf({ results: [quoted, unavailable, { requested: 'x', status: 'quoted' }] }),
    ).toEqual([quoted, unavailable]);
    expect(quotesOf({ data: [] })).toEqual([]);
  });
});

describe('unshownCount', () => {
  it('says how many a preview leaves out', () => {
    expect(unshownCount(11, 4)).toBe(7);
    expect(unshownCount(2, 4)).toBe(0);
  });
});
