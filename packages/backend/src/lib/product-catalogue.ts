import { and, eq, type SQL } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { creditPackages, features, planFeatures, plans } from '../db/schema/index.js';
import {
  getAllClarityModels,
  getAvailableModels,
  getClarityModel,
  getClarityModelsByCategory,
  getDefaultClarityModel,
  getDefaultModelForCategory,
  isClarityModel,
  type ClarityModel,
  type ClarityModelWithAvailability,
  type ModelCategory,
} from './clarity-models.js';

export {
  getAllClarityModels,
  getAvailableModels,
  getClarityModel,
  getClarityModelsByCategory,
  getDefaultClarityModel,
  getDefaultModelForCategory,
  isClarityModel,
};
export type { ClarityModel, ClarityModelWithAvailability, ModelCategory };

export interface PlanData {
  planId: string;
  name: string;
  product: 'clarity' | 'codea';
  creditsPerMonth: number;
  dailyFreeCredits: number;
  monthlyPrice: number;
  annualPrice: number;
  currency: string;
  subtitle: string;
  creditsLabel: string;
  isFeatured: boolean;
  sortOrder: number;
  modelIds: string[];
  isActive: boolean;
  isFree: boolean;
  stripeProductId?: string;
  stripeMonthlyPriceId?: string;
  stripeAnnualPriceId?: string;
  description?: string;
}

export interface CreditPackageData {
  packageId: string;
  name: string;
  credits: number;
  price: number;
  currency: string;
  stripePriceId?: string;
  sortOrder: number;
  isActive: boolean;
  description?: string;
}

export interface FeatureData {
  featureId: string;
  label: string;
  description?: string;
  icon?: string;
  category: string;
  featureType: 'boolean' | 'limit';
  sortOrder: number;
  isVisibleOnPricing: boolean;
  isActive: boolean;
}

export interface PlanFeatureData {
  planId: string;
  featureId: string;
  enabled: boolean;
  limitValue?: number;
  displayLabel?: string;
  displayDescription?: string;
}

export async function getPlans(filter?: Record<string, unknown>): Promise<PlanData[]> {
  const conditions: SQL[] = [];
  if (typeof filter?.planId === 'string') conditions.push(eq(plans.planId, filter.planId));
  if (typeof filter?.product === 'string') conditions.push(eq(plans.product, filter.product));
  if (typeof filter?.isActive === 'boolean') conditions.push(eq(plans.isActive, filter.isActive));
  return getDb().select().from(plans).where(conditions.length > 0 ? and(...conditions) : undefined) as Promise<PlanData[]>;
}

export async function getCreditPackages(active?: boolean): Promise<CreditPackageData[]> {
  return getDb().select().from(creditPackages)
    .where(active === undefined ? undefined : eq(creditPackages.isActive, active)) as Promise<CreditPackageData[]>;
}

export async function getFeatures(): Promise<FeatureData[]> {
  return getDb().select().from(features) as Promise<FeatureData[]>;
}

export async function getPlanFeatures(planId?: string): Promise<PlanFeatureData[]> {
  return getDb().select().from(planFeatures)
    .where(planId ? eq(planFeatures.planId, planId) : undefined) as Promise<PlanFeatureData[]>;
}

export async function updatePlan(
  planId: string,
  updates: Record<string, unknown>,
): Promise<PlanData | null> {
  const allowed = {
    ...(typeof updates.stripeProductId === 'string' ? { stripeProductId: updates.stripeProductId } : {}),
    ...(typeof updates.stripeMonthlyPriceId === 'string' ? { stripeMonthlyPriceId: updates.stripeMonthlyPriceId } : {}),
    ...(typeof updates.stripeAnnualPriceId === 'string' ? { stripeAnnualPriceId: updates.stripeAnnualPriceId } : {}),
    updatedAt: new Date(),
  };
  const [row] = await getDb().update(plans).set(allowed).where(eq(plans.planId, planId)).returning();
  return row as PlanData | undefined ?? null;
}
