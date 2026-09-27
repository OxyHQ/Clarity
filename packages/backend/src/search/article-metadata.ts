/**
 * When an article was published, and by whom — read from what the page states
 * about itself, never guessed from when Clarity happened to crawl it.
 *
 * Sources, strongest first: the page's JSON-LD (`datePublished`, `publisher`),
 * then its meta tags, and for the date alone, a date written into the URL path
 * (`/2026/09/25/`, `/2026/sep/25/`). A crawl time is not a publication time: a
 * 2023 article crawled today must not read as "10 minutes ago".
 */

import { asRecord } from '../lib/json-record.js';
import { flattenNodes, typesOf } from './jobs/extract.js';

export interface ArticleMetadata {
  publishedAt?: Date;
  modifiedAt?: Date;
  publisher?: string;
}

/** Earliest and latest dates a publication date may plausibly carry. */
const EARLIEST = Date.UTC(1990, 0, 1);
const FUTURE_SLACK_MS = 2 * 24 * 60 * 60 * 1000;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** A time that a publication date may plausibly carry. */
function plausibleTime(time: number, now: number): boolean {
  return Number.isFinite(time) && time >= EARLIEST && time <= now + FUTURE_SLACK_MS;
}

/** A timestamp only if it is a real, plausible date. */
export function plausibleDate(value: unknown, now = Date.now()): Date | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value.trim())) return undefined;
  const date = new Date(value.trim());
  return plausibleTime(date.getTime(), now) ? date : undefined;
}

function isArticle(node: Record<string, unknown>): boolean {
  return typesOf(node).some((type) => /article|posting|report|blog/.test(type));
}

function nameOf(value: unknown): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  const name = typeof first === 'string' ? first : asRecord(first)?.name;
  return typeof name === 'string' && name.trim() ? name.trim().slice(0, 200) : undefined;
}

/** What the page's structured data says about the article. */
export function metadataFromStructuredData(structuredData: unknown, now = Date.now()): ArticleMetadata {
  const all = flattenNodes(Array.isArray(structuredData) ? structuredData : [structuredData]);
  const candidates = [...all.filter(isArticle), ...all.filter((node) => !isArticle(node))];
  const metadata: ArticleMetadata = {};
  for (const node of candidates) {
    metadata.publishedAt ??= plausibleDate(node.datePublished, now) ?? plausibleDate(node.dateCreated, now);
    metadata.modifiedAt ??= plausibleDate(node.dateModified, now);
    metadata.publisher ??= nameOf(node.publisher) ?? nameOf(node.sourceOrganization);
  }
  return metadata;
}

/** A date written into the URL path, if it carries a full year/month/day. */
export function dateFromUrl(url: string, now = Date.now()): Date | undefined {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return undefined;
  }
  const match = path.match(/\/((?:19|20)\d{2})[/-](\d{1,2}|[a-z]{3})[/-](\d{1,2})(?:[/-]|$)/);
  if (!match) return undefined;
  const month = /^\d+$/.test(match[2]) ? Number(match[2]) : MONTHS.indexOf(match[2]) + 1;
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(Date.UTC(Number(match[1]), month - 1, day));
  if (date.getUTCDate() !== day) return undefined;
  return plausibleTime(date.getTime(), now) ? date : undefined;
}
