/**
 * Compatibility exports for product-facing Clarity model metadata.
 *
 * Provider resolution and adapter construction intentionally do not exist in
 * this package. Chat turns cross the Alia agent boundary instead.
 */
export {
  getDefaultClarityModel,
  getClarityModel,
  getAllClarityModels,
  getClarityModelsByCategory,
  getDefaultModelForCategory,
  getAvailableModels,
  isClarityModel,
} from './clarity-models.js';

export type {
  ClarityModel,
  ClarityModelWithAvailability,
  ModelCategory,
} from './clarity-models.js';
