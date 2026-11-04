# Crawl queue recovery

A healthy API and a running worker do not prove that crawls advance. Compare
completed-page timestamps, expired leases and queued work before restarting or
scaling a worker. `GET /health` checks dependencies; it does not drain the queue.

Run production database diagnostics in the VPC using a one-shot task with the
live `clarity-worker` task definition and network configuration. Inject its
existing database secret; never print the connection string. The task's command
must use a read-only transaction and a bounded statement timeout:

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
SELECT status, count(*), min(created_at), max(updated_at),
       count(*) FILTER (WHERE status = 'fetching' AND lease_expires_at < now()) AS expired
FROM clarity_crawl_pages GROUP BY status;
SELECT status, count(*), min(created_at), max(updated_at)
FROM clarity_crawl_jobs GROUP BY status;
COMMIT;
```

For an affected URL, inspect `clarity_crawl_pages.url`, `attempt_count`,
`last_error_code`, `lease_expires_at`, `created_at` and `updated_at`. Multiple
queued rows with zero attempts point to repeated enqueueing, not a fetch refusal
by the publisher. Avoid fetching the article repeatedly just to diagnose it:
older `/v1/resolve` implementations create another operation on every read.

The worker recovers expired leases before taking new work. A page below three
attempts returns to `retry`; an exhausted page becomes `failed`, its abandoned
fetch attempt closes, and its operation completes once no pages remain pending.
Active claims renew every 20 seconds. Result commits lock the page and check its
owner, attempt and live lease, so a late response from the previous worker cannot
overwrite a recovered claim. HTTP fetches, including the response body, have a
30-second deadline. Saturated or contended accounts cannot block unrelated work.
A requested preview receives queue priority over historical bulk work; its retry
deadline remains unchanged, so priority never bypasses fetch backoff.

Release and recovery order:

1. Apply the additive URL lookup/priority migrations, then deploy the API's URL
   reuse fix so polling stops adding duplicate crawls.
   Migration `0018_resolve_priority` adds a persisted
   priority: current `/resolve` reads promote only their queued/retry pages,
   while preserving retry eligibility times and live leases. Keep cached
   documents available even when new work cannot be admitted.
2. Deploy the worker's lease recovery and fenced commits. Confirm the
   `Recovered expired crawl leases` log and that completed-page timestamps
   advance. A deployment alone does not remove the old duplicate backlog.
3. Preview the scoped duplicate-backlog repair, review the account/application
   and bounded candidate count, then explicitly apply the reviewed batch.
   Preserve a surviving operation for each URL; do not delete in-flight pages.
4. Recheck queue age and duplicates. Read the affected Mention posts and their
   pending-document follow-up; the final response must contain extracted Clarity
   documents (title, description and any available hosted image), not just a
   cleared pending flag.

A real HTTP rejection, removed article, unsupported content type or publisher's
indexing restriction remains a source-specific failure. Inspect the recorded
fetch result before retrying it. Never manufacture a successful document to
hide a stopped queue.

## Failed previews

A fetch failure is classified where it happens (`src/search/fetch-failure.ts`).
Rate limiting (429), 408/425, 5xx, timeouts, resets and refused connections are
transient: the page is retried with backoff and ends `fetch_unavailable`, which
`/v1/resolve` reports as retryable for half an hour. Anything else is the
site's answer (`fetch_failed`), fails on the first attempt and is held for six
hours. A worker that stops mid-fetch (`lease_expired`) is transient too.

A page whose title comes from no source (OpenGraph, Twitter card, JSON-LD,
oEmbed, `<title>`, Readability) is not stored: it is a bot interstitial or a
script-only shell (Amazon serves one to most crawls), so it ends
`untitled_page`, transient. `/resolve` ignores documents older crawls stored
without a title and crawls those URLs again. A linked PDF is a document titled
by its metadata (XMP `dc:title`, else the information dictionary's `/Title`)
or, when that is compressed or absent, its file name (`src/search/pdf-metadata.ts`).

Before a failure is recorded, a URL a registered oEmbed provider covers
(`src/search/oembed-providers.generated.json`, refreshed with
`bun run --filter @clarity/backend oembed:refresh` from oembed.com's registry)
is indexed from the provider's answer when its endpoint allows ClarityBot in
robots.txt. Measured on 2026-11-04, YouTube served Clarity's egress a degraded
page (no OpenGraph, `<link rel=canonical href=".../undefined">`) or a 429 for
nearly every video; its oEmbed endpoint answered every time. Some publishers
cannot be reached this way: The New York Times disallows `/svc` (its oEmbed
endpoint) and Reddit disallows everything for unnamed agents, and cbc.ca and
npr.org drop connections from AWS addresses, robots.txt included.

After a fix, re-queue the previews that failed for its cause. Run the built
one-shot with the live `clarity-worker` task definition; the default is a
read-only preview of the candidates by cause:

```bash
bun packages/backend/dist/db/reindex-failed-previews.js \
  --target-database=clarity \
  --owner-account-id=REVIEWED_OWNER \
  --application-id=REVIEWED_APPLICATION \
  --since=2026-10-28T00:00:00Z \
  --causes=oembed,extraction,unmatched,transient \
  --limit=1000 --batch=200
```

A candidate is a URL whose latest resolve crawl for that owner and application
ended with no document, with nothing queued for it now. Repeat with `--apply`
to queue the selected URLs in batches of `--batch`, each one resolve operation
with the original caller's authority at background priority; the next batch
waits until the previous one has been fetched once (retries wait out their own backoff), so live reads keep their place.

## Duplicate resolve batches

`POST /v1/resolve` reuses active URL operations within the caller's account and
application, including overlapping batches. The queue URL/status index in
migration `0017_crawl_page_url` makes this lookup bounded by the requested URLs.

The repair command coalesces the historical duplicate reads after deploying
that fix and the worker's lease recovery. It never deletes rows. Only unclaimed,
never-attempted queued pages in URL operations whose key starts with `resolve:`
qualify. Owner, application, credential and caller tier remain separate. An
in-flight page takes precedence, followed by current-reader priority, retrying
work and the oldest untouched copy.
Explicit indexing and site operations are excluded. Review the key convention
in the selected account before applying: clients must not have used the reserved
`resolve:` prefix for explicit indexing requests.

Supply the production database through the normal secret mechanism; commands do
not print connection strings. Every invocation requires the expected database,
owner, application and cutoff. The default is a read-only transaction:

```bash
bun packages/backend/src/scripts/recover-duplicate-resolves.ts \
  --target-database=clarity \
  --owner-account-id=REVIEWED_OWNER \
  --application-id=REVIEWED_APPLICATION \
  --before=2026-10-07T00:00:00Z \
  --limit=1000
```

The report names the scope, bounded candidate count and ten sample public URLs,
page IDs and retained page IDs. `pages` is the candidate count for this batch,
not the entire backlog. There is a 30-second statement timeout and a five-second
lock timeout. If the query times out, inspect its plan before increasing limits.

After reviewing the dry run, repeat the same command with `--apply` to mark the
selected duplicates `failed` with `resolve_superseded` and the retained page ID.
Wholly superseded operations become `cancelled`; mixed operations with remaining
work stay active. Rows claimed concurrently are skipped. No fetched-page
results, fetch attempts, usage history or live leases are deleted or rewritten.

Re-run bounded batches until the preview reaches zero. A repeated application
is safe. Recheck the worker's oldest pending page age and the affected URLs'
`/v1/resolve` results. If the retained fetch fails, a future resolve may enqueue
it again through the normal quota and retry path. This repair is never run
automatically on application startup.

Local verification uses only the disposable database:

```bash
TEST_DATABASE_URL=postgresql://nate@localhost:5547/clarity_ci bun run --cwd packages/backend test src/routes/v1/__tests__/resolve.postgres.test.ts src/search/__tests__/resolve-recovery.postgres.test.ts
```

The backend build also emits `dist/db/recover-duplicate-resolves.js` for the
production one-shot task. Run it with Node and the same flags shown above.
