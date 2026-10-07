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

Release and recovery order:

1. Deploy the API's URL reuse fix and its lookup index so polling stops adding
   duplicate crawls. Keep cached documents available even when new work cannot
   be admitted.
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
