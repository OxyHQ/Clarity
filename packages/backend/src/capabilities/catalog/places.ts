import type { CatalogTool } from '@oxy.so/contracts';

import { PLACE_KINDS } from '@clarity.surf/sdk/vocabularies';
import { enumInput, idInput, integerInput, objectInput, readTool, textInput } from './define.js';

/** The canonical gazetteer (GeoNames, CC BY 4.0). Reference data only. */
export const PLACE_TOOLS: readonly CatalogTool[] = [
  readTool({
    name: 'searchPlaces',
    description:
      'Find a city, region or country in Clarity’s gazetteer (GeoNames) by name in any language. Exact names first, then prefixes, then close spellings, each ordered by population. Use it to resolve an ambiguous place before searching jobs there.',
    capability: 'places.read',
    input: objectInput(
      {
        q: textInput(100),
        countryCode: {
          type: 'string',
          minLength: 2,
          maxLength: 2,
          description: 'ISO 3166-1 alpha-2 country to search within.',
        },
        kind: enumInput(PLACE_KINDS),
        limit: integerInput(1, 50),
      },
      ['q'],
    ),
  }),
  readTool({
    name: 'getPlace',
    description: 'Read one place by its GeoNames id (a job location’s placeId).',
    capability: 'places.read',
    input: objectInput({ placeId: idInput }, ['placeId']),
  }),
];
