import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, isNull, or, sql, type SQL } from 'drizzle-orm';

import { getDb } from './index.js';
import { suggestions } from './schema/index.js';

export type SuggestionRow = typeof suggestions.$inferSelect;
export type SuggestionType = 'welcome' | 'autocomplete';
export type SuggestionScope = 'global' | 'personal';

export function deriveTemplateFields(text: string): { isTemplate: boolean; templateVariables: string[] } {
  const matches = text.match(/\{(\w+)\}/g);
  if (!matches) return { isTemplate: false, templateVariables: [] };
  return { isTemplate: true, templateVariables: [...new Set(matches.map((match) => match.slice(1, -1)))] };
}

function notExpired(): SQL {
  return or(isNull(suggestions.expiresAt), gt(suggestions.expiresAt, sql`now()`)) as SQL;
}

function visibleTo(oxyUserId?: string): SQL {
  if (!oxyUserId) return eq(suggestions.scope, 'global');
  return or(
    eq(suggestions.scope, 'global'),
    and(eq(suggestions.scope, 'personal'), eq(suggestions.oxyUserId, oxyUserId)),
  ) as SQL;
}

export interface NewSuggestion {
  suggestionId: string;
  title: string;
  text: string;
  description?: string;
  type: SuggestionType;
  category?: string;
  triggerWords?: string[];
  tags?: string[];
  occupations?: string[];
  interests?: string[];
  scope: SuggestionScope;
  oxyUserId?: string;
  language: string;
  priority?: number;
  isBuiltIn?: boolean;
  isAiGenerated?: boolean;
  expiresAt?: Date;
}

function insertValues(input: NewSuggestion): typeof suggestions.$inferInsert {
  return {
    id: randomUUID(),
    suggestionId: input.suggestionId,
    title: input.title,
    text: input.text,
    description: input.description ?? null,
    type: input.type,
    category: input.category ?? null,
    triggerWords: input.triggerWords ?? [],
    tags: input.tags ?? [],
    occupations: input.occupations ?? [],
    interests: input.interests ?? [],
    scope: input.scope,
    oxyUserId: input.oxyUserId ?? null,
    language: input.language,
    priority: input.priority ?? 0,
    isBuiltIn: input.isBuiltIn ?? false,
    isAiGenerated: input.isAiGenerated ?? false,
    expiresAt: input.expiresAt ?? null,
    ...deriveTemplateFields(input.text),
  };
}

export async function createSuggestion(input: NewSuggestion): Promise<SuggestionRow> {
  const [row] = await getDb().insert(suggestions).values(insertValues(input)).returning();
  if (!row) throw new Error('suggestion insert returned no row');
  return row;
}

export async function listSuggestions(input: {
  language: string;
  type?: SuggestionType;
  category?: string;
  oxyUserId?: string;
  limit: number;
  offset: number;
}): Promise<SuggestionRow[]> {
  const conditions: SQL[] = [
    eq(suggestions.language, input.language),
    notExpired(),
    visibleTo(input.oxyUserId),
  ];
  if (input.type) conditions.push(eq(suggestions.type, input.type));
  if (input.category && input.category !== 'all') conditions.push(eq(suggestions.category, input.category));
  return getDb().select().from(suggestions).where(and(...conditions))
    .orderBy(desc(suggestions.priority), desc(suggestions.usageCount), asc(suggestions.title))
    .limit(input.limit).offset(input.offset);
}

export async function listWelcomePool(
  language: string,
  oxyUserId: string | undefined,
  limit: number,
): Promise<SuggestionRow[]> {
  return getDb().select().from(suggestions).where(and(
    eq(suggestions.type, 'welcome'),
    eq(suggestions.language, language),
    notExpired(),
    visibleTo(oxyUserId),
  )).orderBy(desc(suggestions.priority), desc(suggestions.id)).limit(limit);
}

export async function listOwnSuggestions(oxyUserId: string): Promise<SuggestionRow[]> {
  return getDb().select().from(suggestions).where(and(
    eq(suggestions.oxyUserId, oxyUserId),
    eq(suggestions.scope, 'personal'),
  )).orderBy(desc(suggestions.createdAt), desc(suggestions.id));
}

export interface SuggestionPatch {
  title?: string;
  text?: string;
  description?: string | null;
  type?: SuggestionType;
  category?: string | null;
  triggerWords?: string[];
  tags?: string[];
  expiresAt?: Date | null;
}

export async function updateOwnSuggestion(
  suggestionId: string,
  oxyUserId: string,
  patch: SuggestionPatch,
): Promise<SuggestionRow | null> {
  const set = {
    ...patch,
    ...(patch.text === undefined ? {} : deriveTemplateFields(patch.text)),
    updatedAt: new Date(),
  };
  const [row] = await getDb().update(suggestions).set(set).where(and(
    eq(suggestions.suggestionId, suggestionId),
    eq(suggestions.oxyUserId, oxyUserId),
    eq(suggestions.isBuiltIn, false),
  )).returning();
  return row ?? null;
}

export async function deleteOwnSuggestion(suggestionId: string, oxyUserId: string): Promise<boolean> {
  const result = await getDb().delete(suggestions).where(and(
    eq(suggestions.suggestionId, suggestionId),
    eq(suggestions.oxyUserId, oxyUserId),
    eq(suggestions.isBuiltIn, false),
  ));
  return result.count > 0;
}

export async function incrementSuggestionUsage(suggestionId: string): Promise<void> {
  await getDb().update(suggestions).set({ usageCount: sql`${suggestions.usageCount} + 1` })
    .where(eq(suggestions.suggestionId, suggestionId));
}

function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/[%_]/g, (character) => `\\${character}`);
}

export async function searchSuggestions(input: {
  query: string;
  scope: SuggestionScope;
  oxyUserId?: string;
  limit: number;
}): Promise<Array<Pick<SuggestionRow, 'suggestionId' | 'title' | 'text' | 'language' | 'triggerWords'>>> {
  const escaped = escapeLike(input.query.toLowerCase());
  const conditions: SQL[] = [
    eq(suggestions.scope, input.scope),
    notExpired(),
    or(
      sql`exists (select 1 from unnest(${suggestions.triggerWords}) word where word ilike ${`${escaped}%`} escape '\\')`,
      sql`${suggestions.title} ilike ${`%${escaped}%`} escape '\\'`,
      sql`${suggestions.text} ilike ${`%${escaped}%`} escape '\\'`,
    ) as SQL,
  ];
  if (input.scope === 'personal') {
    if (!input.oxyUserId) return [];
    conditions.push(eq(suggestions.oxyUserId, input.oxyUserId));
  }
  return getDb().select({
    suggestionId: suggestions.suggestionId,
    title: suggestions.title,
    text: suggestions.text,
    language: suggestions.language,
    triggerWords: suggestions.triggerWords,
  }).from(suggestions).where(and(...conditions))
    .orderBy(desc(suggestions.priority), desc(suggestions.usageCount))
    .limit(input.limit);
}
