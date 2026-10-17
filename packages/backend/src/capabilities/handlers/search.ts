import { z } from 'zod';

import { listNewsStories } from '../../search/news.js';
import {
  findDocument,
  findDocumentByUrl,
  SearchError,
  searchIndex,
  searchSchema,
} from '../../search/document-search.js';
import {
  type ClarityToolHandlers,
  notFound,
  parseInput,
  requiredString,
  ToolError,
} from './context.js';

const newsSchema = z.object({
  limit: z.number().int().min(1).optional(),
  languages: z.array(z.string()).max(5).optional(),
});

export const SEARCH_HANDLERS: ClarityToolHandlers = {
  search: async (input) => {
    try {
      return await searchIndex(parseInput(searchSchema, input));
    } catch (error) {
      if (error instanceof SearchError)
        throw new ToolError(error.status, error.code, error.message);
      throw error;
    }
  },
  getDocument: async (input) => {
    const document = await findDocument(requiredString(input, 'documentId'));
    if (!document) throw notFound('document_not_found', 'Document not found');
    return document;
  },
  getDocumentByUrl: async (input) => {
    const document = await findDocumentByUrl(requiredString(input, 'url'));
    if (!document) throw notFound('document_not_found', 'Document not found');
    return document;
  },
  // The anonymous `/news` door's answer: a reader's languages with no news yet
  // get every language rather than an empty page.
  listNews: async (input) => {
    const { limit, languages } = parseInput(newsSchema, input);
    const query = { limit, languages: languages?.join(',') };
    let data = await listNewsStories(query);
    if (data.length === 0 && query.languages) data = await listNewsStories({ limit });
    return { data };
  },
};
