// Read-only storage probe for Clarity. Session is read-only; every statement is bounded.
import { createRequire } from 'node:module';
const require = createRequire(process.env.APP_PKG || '/app/packages/backend/package.json');
const pgm = require('postgres'); const postgres = pgm.default ?? pgm;
const u = new URL(process.env.CLARITY_DATABASE_URL);
u.username = encodeURIComponent(process.env.PG_USER);
u.password = encodeURIComponent(process.env.PG_PASSWORD);
const sql = postgres(u.toString(), {
  max: 1,
  ssl: 'require',
  connection: {
    application_name: 'clarity-storage-probe',
    default_transaction_read_only: 'on',
    statement_timeout: '120000',
    lock_timeout: '1000',
  },
});
const out = (k, v) => console.log(`PROBE ${k} ${JSON.stringify(v)}`);
const q = async (k, text) => {
  const t = Date.now();
  try {
    const rows = await sql.unsafe(text);
    out(k, rows);
  } catch (e) {
    out(k, { error: String(e.message).slice(0, 300) });
  }
  out(`${k}.ms`, Date.now() - t);
  await new Promise((r) => setTimeout(r, 2000));
};
const S = process.env.SAMPLE_PCT || '0.1';
await q('whoami', `select current_user, current_database(), version(), current_setting('default_toast_compression') toast, current_setting('shared_buffers') sb, (select stats_reset from pg_stat_database where datname=current_database()) stats_reset, pg_database_size(current_database()) db_bytes`);
await q('tables', `select c.relname, c.reltuples::bigint rows, pg_relation_size(c.oid) heap, coalesce(pg_total_relation_size(nullif(c.reltoastrelid,0)),0) toast, pg_indexes_size(c.oid) idx, pg_total_relation_size(c.oid) total, s.n_dead_tup dead, s.n_tup_ins ins, s.n_tup_upd upd, s.n_tup_del del from pg_class c left join pg_stat_user_tables s on s.relid=c.oid where c.relkind='r' and c.relnamespace='public'::regnamespace order by total desc limit 45`);
await q('indexes', `select i.relname tbl, i.indexrelname idx, i.idx_scan scans, i.last_idx_scan last_scan, i.idx_tup_read tup_read, pg_relation_size(i.indexrelid) bytes, x.indisunique uniq, x.indisprimary pk, (select count(*) from pg_constraint k where k.conindid=i.indexrelid) cons from pg_stat_user_indexes i join pg_index x on x.indexrelid=i.indexrelid order by bytes desc limit 80`);
await q('idxdefs', `select indexname, indexdef from pg_indexes where schemaname='public' and (indexdef ilike '%hnsw%' or indexdef ilike '%gin%' or indexdef ilike '%gist%')`);
await q('colstorage', `select c.relname, a.attname, a.attstorage, a.attcompression from pg_attribute a join pg_class c on c.oid=a.attrelid where c.relnamespace='public'::regnamespace and c.relkind='r' and a.attnum>0 and not a.attisdropped and c.relname in ('clarity_search_chunks','clarity_search_chunk_vectors','clarity_search_documents','clarity_job_postings','clarity_job_search_vectors','clarity_job_term_bands') and a.attstorage<>'p'`);
await q('pgstats', `select tablename, attname, avg_width, null_frac, n_distinct from pg_stats where schemaname='public' and tablename in ('clarity_search_chunks','clarity_search_chunk_embeddings','clarity_search_chunk_vectors','clarity_search_documents','clarity_job_postings','clarity_job_search_vectors','clarity_job_term_bands','clarity_job_headlines','clarity_job_posting_signatures','clarity_search_usage_events','clarity_job_clusters') order by tablename, avg_width desc`);
await q('backlog', `select count(*) from clarity_search_chunk_backlog`);
await q('chunks_sample', `
  with s as (select id, document_id, position, length(text) len, octet_length(text) oct, pg_column_size(text) stored, created_at from clarity_search_chunks tablesample system (${S}) repeatable (7))
  select d.document_type t, d.status, d.noindex, count(*) n, avg(s.len)::int len, avg(s.oct)::int oct, avg(s.stored)::int stored,
    count(*) filter (where s.len < 400) short, count(*) filter (where s.position > 0) nonfirst,
    count(*) filter (where s.created_at < now() - interval '30 days') old30,
    count(*) filter (where e.chunk_id is null) unembedded
  from s left join clarity_search_documents d on d.id = s.document_id
  left join clarity_search_chunk_embeddings e on e.chunk_id = s.id
  group by 1,2,3 order by n desc`);
await q('jobchunks_by_status', `
  with s as (select document_id from clarity_search_chunks tablesample system (${S}) repeatable (7)),
  j as (select s.document_id, (select coalesce(bool_or(p.status='active'),false) from clarity_job_postings p where p.document_id=s.document_id) active,
         (select string_agg(distinct p.status, ',' order by p.status) from clarity_job_postings p where p.document_id=s.document_id) sts,
         (select max(p.last_seen_at) from clarity_job_postings p where p.document_id=s.document_id) seen
        from s join clarity_search_documents d on d.id=s.document_id and d.document_type='job')
  select active, sts, count(*) chunks, count(*) filter (where seen < now()-interval '30 days') unseen30 from j group by 1,2 order by chunks desc limit 20`);
await q('docs_sample', `
  with s as (select * from clarity_search_documents tablesample system (${Number(S) * 3}) repeatable (7))
  select document_type t, status, noindex, count(*) n, avg(pg_column_size(s.*))::int row_bytes,
    avg(coalesce(pg_column_size(main_content),0))::int main, count(main_content) main_n,
    avg(coalesce(pg_column_size(description),0))::int descr, avg(pg_column_size(structured_data))::int sd,
    avg(pg_column_size(field_evidence))::int fe, avg(pg_column_size(authors))::int au, avg(pg_column_size(tags))::int tags,
    avg(coalesce(pg_column_size(title),0)+coalesce(pg_column_size(requested_url),0)+coalesce(pg_column_size(final_url),0)+coalesce(pg_column_size(canonical_url),0))::int urls_title,
    count(*) filter (where not exists (select 1 from clarity_search_chunks c where c.document_id=s.id)) nochunks,
    count(*) filter (where coalesce(fetched_at, updated_at) < now()-interval '30 days') old30
  from s group by 1,2,3 order by n desc limit 25`);
await q('postings_sample', `
  with s as (select * from clarity_job_postings tablesample system (${Number(S) * 3}) repeatable (7))
  select status, count(*) n, avg(pg_column_size(s.*))::int row_bytes, avg(coalesce(pg_column_size(description),0))::int descr,
    avg(coalesce(pg_column_size(qualifications),0)+coalesce(pg_column_size(responsibilities),0)+coalesce(pg_column_size(benefits),0)+coalesce(pg_column_size(education_requirements),0)+coalesce(pg_column_size(experience_requirements),0))::int sections,
    avg(pg_column_size(field_evidence))::int fe, avg(pg_column_size(locations))::int loc,
    count(*) filter (where last_seen_at < now()-interval '14 days') unseen14, count(*) filter (where last_seen_at < now()-interval '30 days') unseen30,
    count(*) filter (where cluster_id is not null) clustered
  from s group by 1 order by n desc`);
await q('clusters', `select count(*) clusters, sum(member_count) members, count(*) filter (where member_count>1) multi, sum(member_count-1) filter (where member_count>1) extra from clarity_job_clusters tablesample system (${Number(S) * 10}) repeatable (7)`);
await q('vec_sample', `select count(*) n, avg(pg_column_size(embedding))::int emb, avg(pg_column_size(chunk_id))::int id from clarity_search_chunk_vectors tablesample system (0.01) repeatable (7)`);
await q('emb_sample', `select model, count(*) n, avg(pg_column_size(document_id))::int doc, avg(pg_column_size(code))::int code from clarity_search_chunk_embeddings tablesample system (0.1) repeatable (7) group by 1`);
await q('usage_sample', `select operation, count(*) n, count(*) filter (where occurred_at < now()-interval '30 days') old30, count(*) filter (where occurred_at < now()-interval '14 days') old14, count(idempotency_key) idem, avg(pg_column_size(u.*))::int row_bytes from clarity_search_usage_events u tablesample system (1) repeatable (7) group by 1`);
await q('chunks_per_doc', `with s as (select id, document_type t from clarity_search_documents tablesample system (${Number(S) * 3}) repeatable (11) where status='indexed') select t, count(*) docs, sum((select count(*) from clarity_search_chunks c where c.document_id=s.id)) chunks from s group by 1 order by chunks desc`);
await sql.end();
out('done', true);
