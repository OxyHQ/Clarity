import type { CatalogTool } from '@oxy.so/contracts';

import { DOCUMENT_TYPES, SEARCH_MODES } from '../../search/document-search.js';
import { NEWS_MAX_LIMIT } from '../../search/news.js';
import {
  enumInput,
  idInput,
  integerInput,
  isoDateTimeInput,
  objectInput,
  readTool,
  textInput,
  urlInput,
} from './define.js';

/**
 * Clarity's index of the public web. Every result names its canonical source:
 * Clarity indexed the page, it did not write it.
 */
export const SEARCH_TOOLS: readonly CatalogTool[] = [
  readTool({
    name: 'search',
    description:
      "Search Clarity's index of the public web. Results are ranked pages with title, snippet, canonical URL, publisher and publication date; when the index cannot fill the first page, the rest comes from the open web and is ranked below every indexed match. Cite every fact you use with its result's canonicalUrl. `degraded` says the ranking fell back to lexical; `nextCursor` pages on.",
    capability: 'search.web.read',
    input: objectInput(
      {
        query: textInput(500),
        mode: { ...enumInput(SEARCH_MODES), default: 'hybrid' },
        types: { type: 'array', maxItems: DOCUMENT_TYPES.length, items: enumInput(DOCUMENT_TYPES) },
        domains: {
          type: 'array',
          maxItems: 50,
          items: { type: 'string', maxLength: 253 },
          description: 'Only pages on these hosts (e.g. "elpais.com").',
        },
        language: {
          type: 'string',
          maxLength: 35,
          description: 'BCP 47 language of the page, e.g. "es".',
        },
        publishedAfter: isoDateTimeInput,
        publishedBefore: isoDateTimeInput,
        limit: { ...integerInput(1, 100), default: 20 },
        cursor: { type: 'string', maxLength: 512 },
      },
      ['query'],
    ),
  }),
  readTool({
    name: 'getDocument',
    description:
      'Read one indexed page by its Clarity document id (from a search result): its full extracted text, metadata and canonical URL.',
    capability: 'search.web.read',
    input: objectInput({ documentId: idInput }, ['documentId']),
  }),
  readTool({
    name: 'getDocumentByUrl',
    description:
      'Read the page Clarity has indexed for a URL, with its full extracted text. Answers not-found when Clarity has not indexed it; it never fetches the page.',
    capability: 'search.web.read',
    input: objectInput({ url: urlInput }, ['url']),
  }),
  readTool({
    name: 'listNews',
    description:
      'The newest news stories Clarity has indexed, each a cluster of articles about one event with their publishers. A story whose article states no publication date has null dates — never present the crawl time as when the news broke.',
    capability: 'search.news.read',
    input: objectInput({
      limit: integerInput(1, NEWS_MAX_LIMIT),
      languages: {
        type: 'array',
        maxItems: 5,
        items: { type: 'string', minLength: 2, maxLength: 3 },
        description: 'Primary language subtags, e.g. ["es", "en"]. Omitted, every language.',
      },
    }),
  }),
];
