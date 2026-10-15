import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  EXPERIENCE_MAX_ENTRIES,
  type Experience,
  type ExperienceInput,
} from '@clarity.surf/sdk/experience';
import { getDb } from './index.js';
import { experience, experienceErasures } from './schema/index.js';

type ExperienceRow = typeof experience.$inferSelect;
function present(row: ExperienceRow): Experience {
  return {
    id: row.id,
    oxyUserId: row.oxyUserId,
    title: row.title,
    employerOxyAccountId: row.employerOxyAccountId,
    employmentType: row.employmentType as Experience['employmentType'],
    location: row.location,
    startDate: row.startDate,
    endDate: row.endDate,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function fields(input: ExperienceInput) {
  return {
    title: input.title,
    employerOxyAccountId: input.employerOxyAccountId,
    employmentType: input.employmentType ?? null,
    location: input.location ?? null,
    startDate: input.startDate,
    endDate: input.endDate,
    description: input.description ?? null,
  };
}

export async function listExperience(oxyUserId: string): Promise<Experience[]> {
  const rows = await getDb()
    .select()
    .from(experience)
    .where(eq(experience.oxyUserId, oxyUserId))
    .orderBy(
      sql`${experience.endDate} is null desc`,
      desc(experience.endDate),
      desc(experience.startDate),
      experience.id,
    );
  return rows.map(present);
}

export async function createExperience(
  oxyUserId: string,
  input: ExperienceInput,
): Promise<Experience> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${oxyUserId}, 0))`);
    const [erased] = await tx
      .select()
      .from(experienceErasures)
      .where(eq(experienceErasures.oxyUserId, oxyUserId))
      .limit(1);
    if (erased) throw new ExperienceAccountErasedError();
    const rows = await tx
      .select({ id: experience.id })
      .from(experience)
      .where(eq(experience.oxyUserId, oxyUserId))
      .limit(EXPERIENCE_MAX_ENTRIES);
    if (rows.length >= EXPERIENCE_MAX_ENTRIES) throw new ExperienceLimitError();
    const [row] = await tx
      .insert(experience)
      .values({ ...fields(input), id: randomUUID(), oxyUserId })
      .returning();
    return present(row);
  });
}

export async function updateExperience(
  oxyUserId: string,
  id: string,
  input: ExperienceInput,
): Promise<Experience | null> {
  const [row] = await getDb()
    .update(experience)
    .set({ ...fields(input), updatedAt: new Date() })
    .where(and(eq(experience.id, id), eq(experience.oxyUserId, oxyUserId)))
    .returning();
  return row ? present(row) : null;
}

export async function deleteExperience(oxyUserId: string, id: string): Promise<boolean> {
  const rows = await getDb()
    .delete(experience)
    .where(and(eq(experience.id, id), eq(experience.oxyUserId, oxyUserId)))
    .returning({ id: experience.id });
  return rows.length > 0;
}

/** Removes all owned career history, including when processing verified account erasure. */
export async function eraseUserExperience(oxyUserId: string): Promise<void> {
  await getDb().delete(experience).where(eq(experience.oxyUserId, oxyUserId));
}

export class ExperienceAccountErasedError extends Error {
  constructor() {
    super('This account has been erased');
  }
}

/** Called only after verifying an Oxy account.deleted security event. */
export async function eraseDeletedAccountExperience(
  oxyUserId: string,
  eventId: string,
): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${oxyUserId}, 0))`);
    await tx.insert(experienceErasures).values({ oxyUserId, eventId }).onConflictDoNothing();
    await tx.delete(experience).where(eq(experience.oxyUserId, oxyUserId));
  });
}

export class ExperienceLimitError extends Error {
  constructor() {
    super('A profile can have at most 100 experience entries');
  }
}
