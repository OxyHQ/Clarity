/**
 * The Clarity Jobs ranking contract, stated once and shared by the ranker, the
 * agent capability descriptor and the test that enforces it.
 *
 * Employers may pay Oxy for publishing tooling, APIs, verified ingestion or
 * crawl quota. None of that is reachable from ranking: the forbidden list below
 * is not a policy note, it is the assertion set of
 * `src/search/jobs/__tests__/ranking-contract.test.ts`, which fails the build
 * if a commercial signal becomes reachable from the ranking modules.
 */

/** The complete set of inputs allowed to influence organic job ranking. */
export const JOB_RANKING_SIGNALS = [
  'lexical_relevance',
  'semantic_relevance',
  'freshness',
  'listing_completeness',
  'duplicate_suppression',
] as const;

/** Inputs that must never reach ranking, in any weighting, ever. */
export const JOB_FORBIDDEN_RANKING_SIGNALS = [
  'employer_payment',
  'subscription_tier',
  'advertising_spend',
  'commercial_licensing_tier',
  'mercaria_activity',
  'mention_engagement',
  'applicant_behaviour',
  'inferred_sensitive_traits',
] as const;
