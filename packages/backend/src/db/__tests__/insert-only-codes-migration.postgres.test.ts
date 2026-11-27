import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

/**
 * Migrations 0062–0064 (docs/search-storage.md, "Insert-only codes") run, as
 * a deploy runs them, against the tables as they were before: `pre` while the
 * previous image still writes NULL-code rows and fills them, then `post`. The
 * next release's 0065–0067 then make the codes NOT NULL.
 *
 * Each test runs them in a schema of its own, holding only the three tables
 * they touch, so the shared clarity_ci tables (already migrated) are not
 * altered. Each migration runs in one transaction, as `@oxy.so/db`'s runner
 * applies it.
 */
const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suite = databaseUrl ? describe : describe.skip;

const migrations = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'drizzle');
const PRE = ['0062_search_chunk_backlog', '0063_search_chunk_backlog_copy'];
const POST = ['0064_search_chunk_embeddings_move_unembedded'];
const NOT_NULL = [
  '0065_search_chunk_embeddings_code_check',
  '0066_search_chunk_embeddings_validate_code_check',
  '0067_search_chunk_embeddings_not_null',
];

function statementsOf(tag: string): string[] {
  return (
    readFileSync(join(migrations, `${tag}.sql`), 'utf8')
      .split('--> statement-breakpoint')
      // The generated foreign key names the public schema; here it is this one.
      .map((statement) => statement.replaceAll('"public".', '').trim())
      .filter((statement) => statement.length > 0)
  );
}

const code = (bit: string) => bit.repeat(1024);
const owedChunks = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => `chunk-${from + index}`).sort();

suite('the insert-only codes migrations on Postgres', () => {
  const open: postgres.Sql[] = [];
  const schemas: string[] = [];

  /**
   * A schema holding the three tables as migrations 0050–0053 left them:
   * chunks 1–4 embedded, 5–12 owed (NULL codes), as the previous image wrote
   * them. Returns a connection to it.
   */
  async function layout(notices: string[] = []): Promise<postgres.Sql> {
    const schema = `insert_only_codes_${crypto.randomUUID().replaceAll('-', '')}`;
    schemas.push(schema);
    const setup = postgres(databaseUrl, { max: 1 });
    await setup.unsafe(`create schema ${schema}`);
    await setup.end();
    const db = postgres(databaseUrl, {
      max: 1,
      connection: { search_path: `${schema}, public` },
      onnotice: (notice) => notices.push(String(notice.message)),
    });
    open.push(db);
    await db.unsafe(`
      create table clarity_search_chunks (id text primary key, document_id text not null);
      create table clarity_search_chunk_embeddings (
        chunk_id text primary key references clarity_search_chunks(id) on delete cascade,
        document_id text not null,
        code bit(1024),
        model text,
        constraint clarity_search_chunk_embeddings_model_check check ((code is null) = (model is null))
      );
      create index clarity_search_chunk_embeddings_code_hnsw_idx
        on clarity_search_chunk_embeddings using hnsw (code bit_hamming_ops);
      create index clarity_search_chunk_embeddings_unembedded_idx
        on clarity_search_chunk_embeddings (chunk_id) where code is null;
      create table clarity_search_chunk_vectors (
        chunk_id text primary key references clarity_search_chunk_embeddings(chunk_id) on delete cascade,
        embedding halfvec(1024) not null
      );
      insert into clarity_search_chunks (id, document_id)
        select 'chunk-' || n, 'document-' || (n / 4) from generate_series(1, 12) as n;
      insert into clarity_search_chunk_embeddings (chunk_id, document_id, code, model)
        select id, document_id, case when n <= 4 then '${code('1')}'::bit(1024) end,
          case when n <= 4 then 'current-model' end
        from clarity_search_chunks, lateral (select substr(id, 7)::int as n) as numbered;
    `);
    return db;
  }

  /** Another session on the same schema: the image serving while the migrations run. */
  function serving(db: postgres.Sql): postgres.Sql {
    const session = postgres(databaseUrl, {
      max: 1,
      connection: { search_path: db.options.connection.search_path as string },
    });
    open.push(session);
    return session;
  }

  async function apply(db: postgres.Sql, tags: readonly string[]): Promise<void> {
    for (const tag of tags) {
      await db.begin(async (tx) => {
        for (const statement of statementsOf(tag)) await tx.unsafe(statement);
      });
    }
  }

  afterEach(async () => {
    await Promise.all(open.splice(0).map((db) => db.end()));
  });

  afterAll(async () => {
    const teardown = postgres(databaseUrl, { max: 1 });
    for (const schema of schemas) await teardown.unsafe(`drop schema if exists ${schema} cascade`);
    await teardown.end();
  });

  it('copies the owed chunks into the backlog before the rollout, and moves the rest after it', async () => {
    const db = await layout();
    const embeddedBefore = await db`
      select chunk_id, xmin::text || ctid::text as version
      from clarity_search_chunk_embeddings where code is not null order by chunk_id`;

    await apply(db, PRE);
    const copied = await db`select chunk_id from clarity_search_chunk_backlog order by chunk_id`;
    expect(copied.map((row) => row.chunk_id)).toEqual(owedChunks(5, 12));

    // The previous image keeps serving between `pre` and `post`: it fills a
    // NULL-code row (leaving its backlog row, which the sweep drains) and adds
    // a chunk with a NULL-code row the copy never saw.
    await db`update clarity_search_chunk_embeddings
      set code = ${code('0')}::bit(1024), model = 'current-model' where chunk_id = 'chunk-5'`;
    await db`insert into clarity_search_chunks (id, document_id) values ('chunk-13', 'document-3')`;
    await db`insert into clarity_search_chunk_embeddings (chunk_id, document_id)
      values ('chunk-13', 'document-3')`;

    await apply(db, POST);
    const [state] = await db`
      select
        (select count(*) from clarity_search_chunk_embeddings where code is null)::int as "nullCodes",
        (select count(*) from clarity_search_chunk_embeddings)::int as embeddings,
        (select array_agg(chunk_id order by chunk_id) from clarity_search_chunk_backlog) as backlog`;
    expect(state).toEqual({
      nullCodes: 0,
      embeddings: 5,
      backlog: [...owedChunks(5, 12), 'chunk-13'].sort(),
    });
    // The rows already embedded were not touched.
    const embeddedAfter = await db`
      select chunk_id, xmin::text || ctid::text as version
      from clarity_search_chunk_embeddings where chunk_id <> 'chunk-5' order by chunk_id`;
    expect(embeddedAfter).toEqual(embeddedBefore);
  });

  it.each([
    ['0063 (pre)', PRE.slice(1)],
    ['0064 (post)', POST],
  ])('copies past a chunk a re-chunk deletes while %s runs', async (_, copy) => {
    const db = await layout();
    await apply(db, PRE.slice(0, 1));
    // A re-chunk deletes owed chunk 7 and has not committed when the copy
    // starts: the copy's snapshot still holds chunk 7's NULL-code row.
    const rechunk = serving(db);
    let commit: () => void = () => {};
    const committed = new Promise<void>((resolve) => {
      commit = resolve;
    });
    let deleted: () => void = () => {};
    const isDeleted = new Promise<void>((resolve) => {
      deleted = resolve;
    });
    const replaced = rechunk.begin(async (session) => {
      await session`delete from clarity_search_chunks where id = 'chunk-7'`;
      deleted();
      await committed;
    });
    await isDeleted;
    const copying = apply(db, copy);
    // The copy waits for chunk 7's lock; the re-chunk then commits.
    await new Promise((resolve) => setTimeout(resolve, 200));
    commit();
    await replaced;
    await copying;

    const backlog = await db`select chunk_id from clarity_search_chunk_backlog order by chunk_id`;
    expect(backlog.map((row) => row.chunk_id)).toEqual(
      owedChunks(5, 12).filter((id) => id !== 'chunk-7'),
    );
  });

  it('makes the codes NOT NULL in the next release without scanning the table under ACCESS EXCLUSIVE', async () => {
    const notices: string[] = [];
    const db = await layout(notices);
    await apply(db, [...PRE, ...POST]);
    const embeddedBefore = await db`
      select chunk_id, xmin::text || ctid::text as version
      from clarity_search_chunk_embeddings order by chunk_id`;

    await apply(db, NOT_NULL.slice(0, 2));
    notices.length = 0;
    await db.begin(async (tx) => {
      await tx.unsafe('set local client_min_messages = debug1');
      for (const statement of statementsOf(NOT_NULL[2])) await tx.unsafe(statement);
    });

    const [state] = await db`
      select
        (select array_agg(attname::text order by attname) from pg_attribute
          where attrelid = 'clarity_search_chunk_embeddings'::regclass and attnotnull and attnum > 0) as "notNull",
        (select coalesce(array_agg(conname::text), '{}') from pg_constraint
          where conrelid = 'clarity_search_chunk_embeddings'::regclass and contype = 'c') as checks,
        (select array_agg(c.relname::text order by c.relname) from pg_index i
          join pg_class c on c.oid = i.indexrelid
          where i.indrelid = 'clarity_search_chunk_embeddings'::regclass) as indexes`;
    expect(state).toEqual({
      notNull: ['chunk_id', 'code', 'document_id', 'model'],
      checks: [],
      indexes: [
        'clarity_search_chunk_embeddings_code_hnsw_idx',
        'clarity_search_chunk_embeddings_pkey',
      ],
    });
    const embeddedAfter = await db`
      select chunk_id, xmin::text || ctid::text as version
      from clarity_search_chunk_embeddings order by chunk_id`;
    expect(embeddedAfter).toEqual(embeddedBefore);
    // SET NOT NULL proved both columns from the validated check instead of
    // scanning the table under ACCESS EXCLUSIVE.
    expect(notices.filter((notice) => notice.includes('sufficient to prove'))).toEqual([
      expect.stringContaining('clarity_search_chunk_embeddings.code'),
      expect.stringContaining('clarity_search_chunk_embeddings.model'),
    ]);
  });
});
