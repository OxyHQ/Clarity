import { getPlace, placeSearchSchema, searchPlaces } from '../../search/places/repository.js';
import { type ClarityToolHandlers, notFound, parseInput, requiredString } from './context.js';

export const PLACE_HANDLERS: ClarityToolHandlers = {
  searchPlaces: async (input) => ({
    data: await searchPlaces(parseInput(placeSearchSchema, input)),
  }),
  getPlace: async (input) => {
    const place = await getPlace(requiredString(input, 'placeId'));
    if (!place) throw notFound('place_not_found', 'Place not found');
    return { ...place };
  },
};
