import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Migrations 0062–0067 (docs/search-storage.md, "Insert-only codes") run, as
 * a deploy runs them, against the tables as they were before: `pre` while the
 * previous image still writes NULL-code rows and fills them, then `post`.
 *
 * They run in a schema of their own, holding only the three tables they
 * touch, so the shared clarity_ci tables (already migrated) are not altered.
 * Each migration runs in one transaction, as `@oxy.so/db`'s runner applies it.
 */
const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suite = databaseUrl ? describe : describe.skip;

const migrations = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'drizzle');
const PRE = ['0062_search_chunk_backlog', '0063_search_chunk_backlog_copy'];
const POST = [
  '0064_search_chunk_embeddings_move_unembedded',
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

const schema = `insert_only_codes_${crypto.randomUUID().replaceAll('-', '')}`;
const code = (bit: string) => bit.repeat(1024);

suite('the insert-only codes migrations on Postgres', () => {
  let db: postgres.Sql;
  const notices: string[] = [];

  async function apply(tags: readonly string[]): Promise<void> {
    for (const tag of tags) {
      await db.begin(async (tx) => {
        for (const statement of statementsOf(tag)) await tx.unsafe(statement);
      });
    }
  }

  beforeAll(async () => {
    const setup = postgres(databaseUrl, { max: 1 });
    await setup.unsafe(`create schema ${schema}`);
    await setup.end();
    db = postgres(databaseUrl, {
      max: 1,
      connection: { search_path: `${schema}, public` },
      onnotice: (notice) => notices.push(String(notice.message)),
    });
    // The three tables as migrations 0050–0053 left them.
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
      -- 1–4 embedded, 5–12 owed (NULL codes), as the previous image writes them.
      insert into clarity_search_chunk_embeddings (chunk_id, document_id, code, model)
        select id, document_id, case when n <= 4 then '${code('1')}'::bit(1024) end,
          case when n <= 4 then 'current-model' end
        from clarity_search_chunks, lateral (select substr(id, 7)::int as n) as numbered;
    `);
  });

  afterAll(async () => {
    await db?.end();
    const teardown = postgres(databaseUrl, { max: 1 });
    await teardown.unsafe(`drop schema if exists ${schema} cascade`);
    await teardown.end();
  });

  it('copies the owed chunks into the backlog before the rollout, and moves the rest after it', async () => {
    const embeddedBefore = await db`
      select chunk_id, xmin::text || ctid::text as version
      from clarity_search_chunk_embeddings where code is not null order by chunk_id`;

    await apply(PRE);
    const copied = await db`select chunk_id from clarity_search_chunk_backlog order by chunk_id`;
    expect(copied.map((row) => row.chunk_id)).toEqual(
      Array.from({ length: 8 }, (_, index) => `chunk-${index + 5}`).sort(),
    );

    // The previous image keeps serving between `pre` and `post`: it fills a
    // NULL-code row (leaving its backlog row, which the sweep drains) and adds
    // a chunk with a NULL-code row the copy never saw.
    await db`update clarity_search_chunk_embeddings
      set code = ${code('0')}::bit(1024), model = 'current-model' where chunk_id = 'chunk-5'`;
    await db`insert into clarity_search_chunks (id, document_id) values ('chunk-13', 'document-3')`;
    await db`insert into clarity_search_chunk_embeddings (chunk_id, document_id)
      values ('chunk-13', 'document-3')`;

    await apply(POST.slice(0, 3));
    notices.length = 0;
    await db.begin(async (tx) => {
      await tx.unsafe('set local client_min_messages = debug1');
      for (const statement of statementsOf(POST[3])) await tx.unsafe(statement);
    });

    const [state] = await db`
      select
        (select count(*) from clarity_search_chunk_embeddings where code is null)::int as "nullCodes",
        (select count(*) from clarity_search_chunk_embeddings)::int as embeddings,
        (select array_agg(chunk_id order by chunk_id) from clarity_search_chunk_backlog) as backlog,
        (select array_agg(attname::text order by attname) from pg_attribute
          where attrelid = 'clarity_search_chunk_embeddings'::regclass and attnotnull and attnum > 0) as "notNull",
        (select coalesce(array_agg(conname::text), '{}') from pg_constraint
          where conrelid = 'clarity_search_chunk_embeddings'::regclass and contype = 'c') as checks,
        (select array_agg(c.relname::text order by c.relname) from pg_index i
          join pg_class c on c.oid = i.indexrelid
          where i.indrelid = 'clarity_search_chunk_embeddings'::regclass) as indexes`;
    expect(state).toEqual({
      nullCodes: 0,
      embeddings: 5,
      backlog: [
        ...Array.from({ length: 8 }, (_, index) => `chunk-${index + 5}`),
        'chunk-13',
      ].sort(),
      notNull: ['chunk_id', 'code', 'document_id', 'model'],
      checks: [],
      indexes: [
        'clarity_search_chunk_embeddings_code_hnsw_idx',
        'clarity_search_chunk_embeddings_pkey',
      ],
    });
    // The rows already embedded were not touched.
    const embeddedAfter = await db`
      select chunk_id, xmin::text || ctid::text as version
      from clarity_search_chunk_embeddings where chunk_id <> 'chunk-5' order by chunk_id`;
    expect(embeddedAfter).toEqual(embeddedBefore);
    // SET NOT NULL proved both columns from the validated check instead of
    // scanning the table under ACCESS EXCLUSIVE.
    expect(notices.filter((notice) => notice.includes('sufficient to prove'))).toEqual([
      expect.stringContaining('clarity_search_chunk_embeddings.code'),
      expect.stringContaining('clarity_search_chunk_embeddings.model'),
    ]);
  });
});
