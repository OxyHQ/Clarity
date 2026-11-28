// Read-only vector-quality probe: production query embeddings (Redis cache) against a
// block sample of production chunk vectors. Gold = exact cosine at 1024 dims.
import { createRequire } from 'node:module';
const require = createRequire(process.env.APP_PKG || '/app/packages/backend/package.json');
const pgm = require('postgres'); const postgres = pgm.default ?? pgm;
const rm = require('ioredis'); const Redis = rm.default ?? rm;
const D = 1024;
const out = (k, v) => console.log(`PROBE ${k} ${JSON.stringify(v)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PCT = process.env.SAMPLE_PCT || '0.68';
const MAXQ = Number(process.env.MAX_QUERIES || 400);

// 1. Query embeddings of real searches, from the query-embedding cache (no query text read).
const LOCAL = process.env.LOCAL_TEST === '1';
const rnd = (() => { let x = 12345; return () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648 - 0.5; }; })();
const ru = new URL(process.env.REDIS_URL || 'redis://localhost');
const redis = new Redis({ host: ru.hostname, port: Number(ru.port || 6379), password: ru.password || undefined, username: ru.username || undefined, tls: ru.protocol === 'rediss:' ? {} : undefined, commandTimeout: 5000, lazyConnect: true });
const queries = [];
let cursor = '0', iters = 0;
if (LOCAL) { for (let i = 0; i < MAXQ; i++) queries.push(Float32Array.from({ length: D }, (_, d) => rnd() * (d < 256 ? 3 : 1))); }
else do {
  const [next, keys] = await redis.scan(cursor, 'MATCH', 'clarity:query-embedding:*', 'COUNT', 2000);
  cursor = next; iters++;
  for (const key of keys) {
    if (queries.length >= MAXQ) break;
    const b = await redis.getBuffer(key);
    if (b && b.byteLength === D * 4) queries.push(new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
  }
  if (iters % 50 === 0) await sleep(100);
} while (cursor !== '0' && queries.length < MAXQ && iters < 20000);
if (!LOCAL) redis.disconnect(); else redis.disconnect();
out('queries', { n: queries.length, scanIterations: iters });

// 2. Corpus: a block sample of chunk vectors, read with a cursor and paced.
const u = new URL(process.env.CLARITY_DATABASE_URL || 'postgres://x@localhost/x');
u.username = encodeURIComponent(process.env.PG_USER);
u.password = encodeURIComponent(process.env.PG_PASSWORD);
const sql = postgres(u.toString(), { max: 1, ssl: 'require', connection: { application_name: 'clarity-vector-probe', default_transaction_read_only: 'on', statement_timeout: '120000', lock_timeout: '1000' } });
const CAP = 140000;
const X = new Float32Array(CAP * D);
const docOf = new Int32Array(CAP);
const docIds = new Map();
let n = 0;
const t0 = Date.now();
if (LOCAL) { for (; n < Number(process.env.LOCAL_N || 20000); n++) { docOf[n] = Math.floor(n / 3); for (let i = 0; i < D; i++) X[n * D + i] = rnd() * (i < 256 ? 3 : 1); } }
else {
  // Contiguous block ranges (TID range scans: sequential reads), paced; no join.
  const [{ pages }] = await sql`select relpages::int as pages from pg_class where relname = 'clarity_search_chunk_vectors'`;
  const RANGES = Number(process.env.RANGES || 200), SPAN = Number(process.env.SPAN || 170);
  const chunkIds = [];
  for (let r = 0; r < RANGES && n < CAP; r++) {
    const b0 = Math.floor(((r + 0.37) / RANGES) * (pages - SPAN));
    const rows = await sql.unsafe(`select chunk_id, halfvec_send(embedding) b from clarity_search_chunk_vectors where ctid >= '(${b0},0)'::tid and ctid < '(${b0 + SPAN},0)'::tid`);
    for (const row of rows) {
      if (n >= CAP) break;
      const b = row.b; if (b.readInt16BE(0) !== D) continue;
      chunkIds.push(row.chunk_id);
      for (let i = 0; i < D; i++) X[n * D + i] = half(b.readUInt16BE(4 + 2 * i));
      n++;
    }
    await sleep(400);
  }
  out('sampled', { n, ms: Date.now() - t0 });
  const docOfChunk = new Map();
  for (let i = 0; i < chunkIds.length; i += 2000) {
    const rows = await sql`select chunk_id, document_id from clarity_search_chunk_embeddings where chunk_id = any(${chunkIds.slice(i, i + 2000)}::text[])`;
    for (const row of rows) docOfChunk.set(row.chunk_id, row.document_id);
    await sleep(300);
  }
  chunkIds.forEach((c, j) => { const d = docOfChunk.get(c) ?? c; let id = docIds.get(d); if (id === undefined) { id = docIds.size; docIds.set(d, id); } docOf[j] = id; });
}
await sql.end();

out('corpus', { n, docs: docIds.size, ms: Date.now() - t0 });
function half(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}

// 3. Derived stores.
const W = D / 32;
const bits = new Uint32Array(n * W); // binary_quantize: x > 0
const norm = new Float32Array(n), n512 = new Float32Array(n), n256 = new Float32Array(n), n768 = new Float32Array(n);
const q8 = new Int8Array(n * D), s8 = new Float32Array(n), q8n = new Float32Array(n), q8n512 = new Float32Array(n);
const q4 = new Int8Array(n * D), q4n = new Float32Array(n);
for (let j = 0; j < n; j++) {
  let a = 0, mx = 0, o = j * D;
  for (let i = 0; i < D; i++) {
    const x = X[o + i]; a += x * x; if (Math.abs(x) > mx) mx = Math.abs(x);
    if (x > 0) bits[j * W + (i >> 5)] |= 1 << (i & 31);
    if (i === 255) n256[j] = Math.sqrt(a); if (i === 511) n512[j] = Math.sqrt(a); if (i === 767) n768[j] = Math.sqrt(a);
  }
  norm[j] = Math.sqrt(a);
  const sc = mx / 127; s8[j] = sc; let b = 0, b5 = 0;
  for (let i = 0; i < D; i++) { const v = Math.round(X[o + i] / sc); q8[o + i] = v; b += v * v; if (i === 511) b5 = b; }
  q8n[j] = Math.sqrt(b); q8n512[j] = Math.sqrt(b5);
  const s4 = mx / 7; let c4 = 0;
  for (let i = 0; i < D; i++) { const v = Math.round(X[o + i] / s4); q4[o + i] = v; c4 += v * v; }
  q4n[j] = Math.sqrt(c4) || 1;
}
const pop = new Uint8Array(65536); for (let i = 1; i < 65536; i++) pop[i] = pop[i >> 1] + (i & 1);
const pc = (x) => pop[x & 0xffff] + pop[x >>> 16];

// 4. Variants. Each returns chunk indices, best first.
const topBy = (idx, score, k) => idx.map((j) => [j, score(j)]).sort((a, b) => b[1] - a[1]).slice(0, k).map((p) => p[0]);
const recall = (got, gold) => { const g = new Set(gold); return got.filter((j) => g.has(j)).length / gold.length; };
const docsOf = (chunks, k) => { const seen = []; const s = new Set(); for (const j of chunks) { const d = docOf[j]; if (!s.has(d)) { s.add(d); seen.push(d); if (seen.length === k) break; } } return seen; };
const ndcg = (got, gold) => { const g = new Set(gold); let dcg = 0, idcg = 0; got.forEach((d, r) => { if (g.has(d)) dcg += 1 / Math.log2(r + 2); }); gold.forEach((_, r) => { idcg += 1 / Math.log2(r + 2); }); return dcg / idcg; };
const KS = [10, 50, 400];
const agg = {};
const add = (name, k, key, v) => { const a = (agg[`${name}@${k}`] ??= {}); (a[key] ??= []).push(v); };

function evaluate(q, self) {
  let ownHasOther = false; if (self >= 0) for (let j = Math.max(0, self - 50); j < Math.min(n, self + 50); j++) if (j !== self && docOf[j] === docOf[self]) { ownHasOther = true; break; }
  let qa = 0; for (let i = 0; i < D; i++) qa += q[i] * q[i];
  const qn = Math.sqrt(qa); let q5 = 0, q2 = 0, q7 = 0; for (let i = 0; i < 768; i++) { const t = q[i] * q[i]; if (i < 256) q2 += t; if (i < 512) q5 += t; q7 += t; }
  q5 = Math.sqrt(q5); q2 = Math.sqrt(q2); q7 = Math.sqrt(q7);
  const qb = new Uint32Array(W); for (let i = 0; i < D; i++) if (q[i] > 0) qb[i >> 5] |= 1 << (i & 31);
  let qsum = 0; for (let i = 0; i < D; i++) qsum += q[i];
  const full = new Float32Array(n), p512 = new Float32Array(n), p256 = new Float32Array(n), p768 = new Float32Array(n), ham = new Int32Array(n), ham512 = new Int32Array(n);
  for (let j = 0; j < n; j++) {
    if (j === self) { full[j] = p512[j] = p256[j] = p768[j] = -9; ham[j] = ham512[j] = 9999; continue; }
    const o = j * D; let a = 0, s256 = 0, s512 = 0, s768 = 0;
    for (let i = 0; i < 256; i++) a += q[i] * X[o + i]; s256 = a;
    for (let i = 256; i < 512; i++) a += q[i] * X[o + i]; s512 = a;
    for (let i = 512; i < 768; i++) a += q[i] * X[o + i]; s768 = a;
    for (let i = 768; i < D; i++) a += q[i] * X[o + i];
    full[j] = a / (qn * norm[j]); p512[j] = s512 / (q5 * n512[j]); p256[j] = s256 / (q2 * n256[j]); p768[j] = s768 / (q7 * n768[j]);
    let h = 0, h5 = 0; for (let w = 0; w < W; w++) { const x = pc(bits[j * W + w] ^ qb[w]); h += x; if (w < 16) h5 += x; }
    ham[j] = h; ham512[j] = h5;
  }
  const M = 400 * 16;
  // The best M indices of a float score, best first (threshold from a native sort of the values).
  const sorted = (arr) => { const v = Float32Array.from(arr).sort(); const th = v[Math.max(0, n - M)]; const idx = []; for (let j = 0; j < n; j++) if (arr[j] >= th) idx.push(j); return idx.sort((a, b) => arr[b] - arr[a] || a - b).slice(0, M); };
  // Hamming: counting sort, ties in index order (as an index scan would give some order).
  const byDist = (arr) => { const c = new Int32Array(10001); for (let j = 0; j < n; j++) c[arr[j]]++; let acc = 0, lim = 0; while (lim < 10000 && acc + c[lim] < M) acc += c[lim++]; const idx = []; for (let j = 0; j < n; j++) if (arr[j] <= lim) idx.push(j); return idx.sort((a, b) => arr[a] - arr[b] || a - b).slice(0, M); };
  const goldAll = sorted(full);
  const byHam = byDist(ham), byHam512 = byDist(ham512);
  const asym = (j) => { let s = 0; for (let w = 0; w < W; w++) { const x = bits[j * W + w]; if (!x) continue; for (let b = 0; b < 32; b++) if (x & (1 << b)) s += q[w * 32 + b]; } return 2 * s - qsum; };
  const int8 = (j) => { let s = 0; const o = j * D; for (let i = 0; i < D; i++) s += q[i] * q8[o + i]; return s / q8n[j]; };
  const int4 = (j) => { let s = 0; const o = j * D; for (let i = 0; i < D; i++) s += q[i] * q4[o + i]; return s / q4n[j]; };
  const int8_512 = (j) => { let s = 0; const o = j * D; for (let i = 0; i < 512; i++) s += q[i] * q8[o + i]; return s / q8n512[j]; };
  for (const k of KS) {
    const gold = goldAll.slice(0, k);
    const gDocs = docsOf(goldAll.slice(0, Math.max(k, 400)), 10);
    const pool = (src, m) => src.slice(0, k * m);
    const variants = {
      prod_ham8_exact1024: topBy(pool(byHam, 8), (j) => full[j], k),
      ham8_halfvec768: topBy(pool(byHam, 8), (j) => p768[j], k),
      ham8_halfvec512: topBy(pool(byHam, 8), (j) => p512[j], k),
      ham8_halfvec256: topBy(pool(byHam, 8), (j) => p256[j], k),
      ham8_int8_1024: topBy(pool(byHam, 8), int8, k),
      ham8_int8_512: topBy(pool(byHam, 8), int8_512, k),
      ham8_int4_1024: topBy(pool(byHam, 8), int4, k),
      exact1024: goldAll.slice(0, k),
      ham8_asym_novectors: topBy(pool(byHam, 8), asym, k),
      ham16_asym_novectors: topBy(pool(byHam, 16), asym, k),
      ham4_exact1024: topBy(pool(byHam, 4), (j) => full[j], k),
      ham_only: byHam.slice(0, k),
      exact512_scan: sorted(p512).slice(0, k),
      exact256_scan: sorted(p256).slice(0, k),
      ham512_8_halfvec512: topBy(pool(byHam512, 8), (j) => p512[j], k),
    };
    for (const [name, got] of Object.entries(variants)) {
      add(name, k, 'chunk_recall', recall(got, gold));
      // Documents: what the arm hands the fusion (each document at its nearest chunk).
      const ext = name === 'ham_only' ? byHam.slice(0, Math.max(k, 400)) : got;
      const d = docsOf(ext, 10);
      add(name, k, 'doc_recall10', recall(d, gDocs));
      add(name, k, 'doc_ndcg10', ndcg(d, gDocs));
      if (self >= 0 && k === 400 && ownHasOther) { const r = docsOf(ext, 10).indexOf(docOf[self]); add(name, k, 'own_doc_mrr10', r < 0 ? 0 : 1 / (r + 1)); }
    }
  }
}
const t1 = Date.now();
queries.forEach((q, i) => { evaluate(q, -1); if (i % 50 === 0) out('progress', { i, ms: Date.now() - t1 }); });
const summary = (label) => {
  const r = {};
  for (const [key, m] of Object.entries(agg)) { r[key] = Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Number((v.reduce((a, b) => a + b, 0) / v.length).toFixed(4))])); }
  out(label, r);
};
summary('real_queries');
for (const key of Object.keys(agg)) delete agg[key];
const NC = Number(process.env.CHUNK_QUERIES || 150);
for (let c = 0; c < NC; c++) { const j = Math.floor((c + 0.5) * (n / NC)); evaluate(X.subarray(j * D, j * D + D), j); }
summary('chunk_queries');
out('done', { ms: Date.now() - t0 });
