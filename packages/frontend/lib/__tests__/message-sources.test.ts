import { describe, expect, it } from 'vitest';

import type { ToolInvocation } from '@alia.onl/sdk/model';

import {
  citationUrls,
  collectMessageSources,
  linkCitations,
  resultDomains,
} from '../message-sources';

const search: ToolInvocation = {
  toolCallId: 'call-1',
  toolName: 'webSearch',
  state: 'result',
  args: { query: 'faircoin' },
  result: {
    results: [
      { url: 'https://www.example.com/a', title: 'A', snippet: 'first' },
      { url: 'https://news.example.org/b', title: '', snippet: 'second' },
      { url: 'https://www.example.com/a', title: 'A again' },
      { title: 'no url' },
    ],
  },
};

describe('collectMessageSources', () => {
  it('reads search results, de-duplicates by URL and skips entries without one', () => {
    const sources = collectMessageSources({ toolInvocations: [search] });
    expect(sources.map((source) => source.url)).toEqual([
      'https://www.example.com/a',
      'https://news.example.org/b',
    ]);
    expect(sources[0]).toMatchObject({ title: 'A', domain: 'example.com', snippet: 'first' });
    expect(sources[1].title).toBe('news.example.org');
  });

  it('ignores tool calls that have not finished', () => {
    expect(collectMessageSources({ toolInvocations: [{ ...search, state: 'call' }] })).toEqual([]);
  });

  it('adds deep-research sources after the tool results', () => {
    const sources = collectMessageSources({
      toolInvocations: [search],
      researchProgress: {
        sources: [
          { id: 1, url: 'https://www.example.com/a', title: 'A' },
          { id: 2, url: 'https://r.example/x', title: 'R' },
        ],
      },
    });
    expect(sources.map((source) => source.url)).toEqual([
      'https://www.example.com/a',
      'https://news.example.org/b',
      'https://r.example/x',
    ]);
  });
});

describe("Clarity's own index, through its catalogue", () => {
  const clarity = (tool: string, result: unknown, app = 'clarity'): ToolInvocation => ({
    toolCallId: `call-${tool}`,
    toolName: `oxy_${app}__${tool}`,
    state: 'result',
    args: {},
    result,
  });

  it("reads `search` results as the answer's sources", () => {
    const sources = collectMessageSources({
      toolInvocations: [
        clarity('search', {
          data: [
            { canonicalUrl: 'https://www.example.com/a', title: 'A', snippet: 'first' },
            { canonicalUrl: 'https://b.example/b', description: 'second' },
            { title: 'no url' },
          ],
        }),
      ],
    });
    expect(sources.map((source) => source.url)).toEqual([
      'https://www.example.com/a',
      'https://b.example/b',
    ]);
    expect(sources[0]).toMatchObject({ title: 'A', domain: 'example.com', snippet: 'first' });
  });

  it('reads the one page `getDocument` and `getDocumentByUrl` return', () => {
    const page = { canonicalUrl: 'https://doc.example/p', title: 'P', description: 'a page' };
    for (const tool of ['getDocument', 'getDocumentByUrl']) {
      expect(
        collectMessageSources({ toolInvocations: [clarity(tool, page)] }).map((s) => s.url),
      ).toEqual(['https://doc.example/p']);
    }
  });

  it("adds nothing for Clarity's other tools, nor for another app's", () => {
    expect(
      collectMessageSources({
        toolInvocations: [
          clarity('searchJobs', { data: [{ canonicalUrl: 'https://jobs.example/1' }] }),
          clarity('search', { data: [{ canonicalUrl: 'https://x.example' }] }, 'homiio'),
        ],
      }),
    ).toEqual([]);
  });
});

describe('citations', () => {
  it('numbers by research ids when a research run supplied them', () => {
    const message = {
      researchProgress: { sources: [{ id: 7, url: 'https://r.example/x', title: 'R' }] },
    };
    const urls = citationUrls(message);
    expect(linkCitations('Claim [7] and [8].', urls)).toBe(
      'Claim [[7]](https://r.example/x) and [8].',
    );
  });

  it('links nothing when several searches make the numbering ambiguous', () => {
    const second = {
      ...search,
      toolCallId: 'call-2',
      result: { results: [{ url: 'https://other.example/c', title: 'C' }] },
    };
    expect(citationUrls({ toolInvocations: [search, second] }).size).toBe(0);
  });

  it("numbers by the single search's result order otherwise, and leaves existing links alone", () => {
    const message = { toolInvocations: [search] };
    const urls = citationUrls(message);
    expect(linkCitations('See [1][2] and [1](https://x.example) and [2]: note', urls)).toBe(
      'See [[1]](https://www.example.com/a)[[2]](https://news.example.org/b) and [1](https://x.example) and [2]: note',
    );
  });
});

describe('resultDomains', () => {
  it('lists the distinct sites a search returned', () => {
    expect(resultDomains(search)).toEqual(['example.com', 'news.example.org']);
    expect(resultDomains({ ...search, state: 'call' })).toEqual([]);
  });
});
