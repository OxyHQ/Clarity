import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePostgres, connectPostgres } from '../index.js';
import {
  createExperience, deleteExperience, eraseDeletedAccountExperience, eraseUserExperience,
  ExperienceAccountErasedError, ExperienceLimitError, listExperience, updateExperience,
} from '../experience-repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suite = databaseUrl ? describe : describe.skip;
const owner = `experience-${crypto.randomUUID()}`;
const other = `experience-other-${crypto.randomUUID()}`;
const input = { title: 'Designer', companyName: 'Apple', startDate: '2022-10', endDate: null };
suite('Experience PostgreSQL ownership and lifecycle', () => {
  beforeAll(async () => {
    if (new URL(databaseUrl).pathname.slice(1) !== 'clarity_ci') throw new Error('integration tests require database clarity_ci');
    const client = postgres(databaseUrl, { max: 1 });
    try {
      const [existing] = await client`select to_regclass('public.clarity_experience') as name`;
      if (!existing.name) {
        const migration = await readFile(new URL('../../../drizzle/0019_profile_experience.sql', import.meta.url), 'utf8');
        await client.unsafe(migration);
      }
    } finally { await client.end(); }
    connectPostgres(databaseUrl);
  });
  afterAll(async () => {
    const client = postgres(databaseUrl, { max: 1 });
    await client`delete from clarity_experience where oxy_user_id in (${owner}, ${other})`;
    await client`delete from clarity_experience_erasures where oxy_user_id in (${owner}, ${other})`;
    await client.end();
    await closePostgres();
  });
  it('generates IDs, projects public fields and preserves ownership through replacements', async () => {
    const row = await createExperience(owner, { ...input, description: 'Details' });
    expect(row).toMatchObject({ ...input, oxyUserId: owner });
    expect(row.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(await updateExperience(other, row.id, input)).toBeNull();
    expect(await deleteExperience(other, row.id)).toBe(false);
    expect(await listExperience(other)).toEqual([]);
    const updated = await updateExperience(owner, row.id, { ...input, title: 'Senior designer' });
    expect(updated).toMatchObject({ id: row.id, oxyUserId: owner, title: 'Senior designer', description: null });
    expect(await deleteExperience(owner, row.id)).toBe(true);
    expect(await listExperience(owner)).toEqual([]);
  });
  it('sorts current roles first and then most recently ended work', async () => {
    const older = await createExperience(owner, { ...input, startDate: '2005-10', endDate: '2013-10' });
    const recent = await createExperience(owner, { ...input, startDate: '2013-10', endDate: '2021-06' });
    const current = await createExperience(owner, input);
    expect((await listExperience(owner)).map(row => row.id)).toEqual([current.id, recent.id, older.id]);
    await eraseUserExperience(owner);
    expect(await listExperience(owner)).toEqual([]);
  });
  it('enforces date and employment constraints even outside the API', async () => {
    const client = postgres(databaseUrl, { max: 1 });
    try {
      for (const [start, end, kind] of [['2022-13', null, null], ['2022-01', '2021-01', null], ['2022-01', null, 'invented']]) {
        await expect(client`insert into clarity_experience(id, oxy_user_id, title, company_name, start_date, end_date, employment_type)
          values (${crypto.randomUUID()}, ${owner}, 'Role', 'Company', ${start}, ${end}, ${kind})`).rejects.toThrow();
      }
    } finally { await client.end(); }
  });
  it('atomically bounds history at 100 entries', async () => {
    const client = postgres(databaseUrl, { max: 1 });
    try {
      await client`insert into clarity_experience(id, oxy_user_id, title, company_name, start_date)
        select ${owner} || '-' || n, ${owner}, 'Role', 'Company', '2020-01' from generate_series(1, 99) n`;
      const results = await Promise.allSettled([createExperience(owner, input), createExperience(owner, input)]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find(result => result.status === 'rejected');
      expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(ExperienceLimitError);
      expect(await listExperience(owner)).toHaveLength(100);
      await eraseUserExperience(owner);
    } finally { await client.end(); }
  });
  it('erases deleted accounts idempotently and prevents concurrent recreation', async () => {
    await createExperience(owner, input);
    const preserved = await createExperience(other, input);
    await Promise.all([
      eraseDeletedAccountExperience(owner, 'deleted-event'),
      createExperience(owner, input).catch(error => { expect(error).toBeInstanceOf(ExperienceAccountErasedError); }),
    ]);
    await eraseDeletedAccountExperience(owner, 'deleted-event');
    expect(await listExperience(owner)).toEqual([]);
    expect((await listExperience(other)).map(row => row.id)).toEqual([preserved.id]);
    await expect(createExperience(owner, input)).rejects.toBeInstanceOf(ExperienceAccountErasedError);
  });
});
