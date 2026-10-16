# Clarity's images in Oxy Files

Clarity shows three kinds of remote image: a document's preview image, a job's
employer logo, and a site's favicon. Since Oxy ADR 0043 (stage 4) they are
**files the Clarity application owns in Oxy Files**, not bytes in Clarity's
Postgres. Oxy imports them, renders their sizes, serves them from its CDN, and
deletes them once Clarity stops using them. Clarity keeps the record of which
entity shows which file, and keeps Oxy's references equal to that record.

Code: `packages/backend/src/files/` (the adapter `oxy-files.ts`, which is the
only module that calls Oxy Files; `references.ts`; `legacy-reads.ts`;
`migrate-legacy-images.ts`), `search/image-cache.ts`, `search/site-icons.ts`,
`routes/images.ts`, `routes/favicons.ts` and `routes/oxy-file-events.ts`.

## Who owns what, and who uses it

| Image | Owner | Reference `entityType` / `entityId` | Recorded | Released |
|---|---|---|---|---|
| Document preview (`search_documents.image_url`) | Clarity application, `public` | `search_document` / document id | the first time `/images/documents/:id/…` is served, and again (at most daily) on later requests | the document's `image_url` changes or is cleared, the document is deleted, or it is not served for 30 days |
| Employer logo (`job_postings.employer_logo_url`) | Clarity application, `public` | `job_posting` / posting id | the first time `/images/jobs/:id/…` is served | the logo URL changes or is cleared, the posting is deleted (including the cascade when its document is pruned), or it is not served for 30 days |
| Favicon (`search_hosts`) | Clarity application, `public` | `search_host` / host | when `/favicons/:host` is served | the host's icon is replaced by different bytes (the use moves to the new file) or by an SVG, or it is not served for 30 days |

No person owns any of these, so none is billed, and none is ever a person's
private file.

### What "stops being used" means

Clarity used to delete its own copy of an image nobody had asked for in 30 days.
That rule now applies to the **reference**. Oxy owns the deletion (ADR 0043 D5).
A use (a row in `clarity_image_references`) goes in exactly three cases:

1. **The entity no longer shows that image.** Its URL changed or was cleared,
   or a host's icon changed. A trigger on `clarity_search_documents` and on
   `clarity_job_postings` handles the URL columns. `refreshDueIcons` handles
   icons.
2. **The entity is deleted.** The same triggers handle this, and they also fire
   for the cascade from a pruned document to its job postings.
3. **Nobody has been served the image from that entity in 30 days**
   (`IMAGE_IDLE_TTL_MS`). The worker's `releaseIdleReferences` handles this.

Every insert, delete and file change of a use writes a row to
`clarity_oxy_file_reference_outbox`. A trigger does this in the same
transaction. The worker drains the outbox to Oxy in id order, so an add and a
later remove of one use arrive in that order. Once no use of a file is left,
Oxy trashes it after 24 hours and deletes it 30 days later. If the image is
asked for in between, the request's new use restores it. After that, the
request imports the image again.

A **nightly reconciliation** per entity type (`references.reconcile`, ADR 0043
D6) sends the whole inventory. Oxy adds any use it is missing and removes any
it holds that Clarity no longer lists. This catches whatever the outbox missed.

## Getting an image into Oxy

- **Documents and logos** are imported lazily on the first request with
  `importAppFile(sourceUrl, { visibility: 'public', reference })`. Oxy fetches
  the source with its SSRF-safe fetcher, deduplicates by source URL, and
  registers the use in the same request. After 30 days the next request
  revalidates the image with the source (`revalidate: true`, ETag and
  Last-Modified). If the image changed, it becomes a new file and every use
  moves to that file. If the refresh fails, Clarity keeps the file it had.
- **Some sources Oxy will not fetch itself**: an `http:` URL, or a source whose
  declared type Oxy refuses (415) although its bytes are an image. Clarity
  fetches these through `safeFetch`, renders the `w1280` WebP rung, and
  uploads it with `uploadAppFile`. No image is lost in the move, and the site's
  original bytes are never kept.
- **Favicons** are fetched by the worker as before (page hint, then the home
  page's declaration, then `/favicon.ico`), sniffed, and uploaded with
  `uploadAppFile`. A host whose icon was released is not refreshed on a timer.
  It is fetched again when somebody next asks for it.
- A failed source is remembered for 6 hours. If Oxy is unreachable, nothing is
  remembered: the image answers `503 image_unavailable` with `no-store`, and
  the worker retries an icon within the hour.

### TODO(oxy-4c): SVG favicons

Oxy refuses `image/svg*` for application files (`isAllowedCacheMime`, a
stored-XSS rule). SVG favicons therefore stay in
`clarity_search_hosts.icon_bytes` and are served by `/favicons/:host` under its
sandbox CSP. Reads of them are counted as `favicons_svg`. They are the only
images Oxy cannot hold. Every other image is far below Oxy's 40 MiB cap: 5 MiB
previews and 100 KiB icons. When Oxy's stage 4c holds an SVG and serves it inertly, upload SVG
icons like the others: drop the `oxyCanHold` branch in `files/oxy-files.ts`.

## Serving: stable addresses

`/images/documents/:id/:version`, `/images/jobs/:id/:version` and
`/favicons/:host` keep their addresses. They now answer `302` to
`https://cloud.oxy.so/<file>`:

- Images go to `?variant=w320|w640|w1280`, which defaults to `w1280`. They are
  never sent to the bare original, which Oxy keeps exactly as the site served
  it.
- Favicons go to the stored icon.

Clarity redirects rather than handing out Oxy URLs, for three reasons:

- Every API response, stored link preview, SDK consumer and the frontend
  (`favicons/<host>`) already hold these addresses.
- The first request is what imports an image.
- Serving is what records a use, and that is what lets Clarity release an image
  nobody looks at.

## Oxy's file events

Oxy POSTs file events to `POST /webhooks/oxy/files`. The route is mounted
before `express.json()`. It verifies each event with `verifyFileEventSignature`
against `OXY_FILES_WEBHOOK_SECRET`, echoes the challenge, and acts on each
event id once (`clarity_oxy_file_events`, kept 30 days):

| Event | What Clarity does |
|---|---|
| `file.blocked` | Hides the image or icon: status `blocked`, served as 404, never re-imported. |
| `file.unblocked` | Shows the image again. |
| `file.deleted` | Forgets the file. The next request imports the image again. |
| `file.trashed` | Re-sends any use it still lists, which restores the file. |
| `file.restored`, `file.visibility_changed` | Nothing. |

## Rollout

### Before the grant: exact scope subsets (done)

Clarity's token to Alia must carry exactly `user:read` and `inference:invoke`
(`assertExactClarityServiceClaims`, and the AGENTS.md hard boundary). Clarity
mints it from its attested workload, so before scope subsets every scope granted
to the Clarity Backend workload appeared on it, and a file grant would have made
every Alia call and readiness check fail closed.

That is closed: `@oxy.so/core` mints exact scope subsets (oxy #1718), and
Clarity #123 requests the agent tuple as one (`getClarityServiceToken` and
`getClarityServiceTokenFor`). The Oxy Files adapter's calls mint the unscoped
token, which `OxyServer` caches apart from the subset, so the file scopes reach
only Oxy Files. `clarity-service-auth.test.ts` refuses the full grant (agent
tuple plus `CLARITY_FILES_SCOPES`) as an agent token.

Order: grant the scopes below only once Clarity #123 runs in production (it is
the code that requests the subset), and before deploying this change. A deploy
without the grant is safe but degraded: Oxy refuses the imports (403, never
remembered as a missing image), so an image Clarity does not already hold
answers `503 image_unavailable` until the grant lands.

### Before Oxy stage 4c

Nothing here calls a stage 4c endpoint. SVG favicons (TODO(oxy-4c) above) stay
in `clarity_search_hosts.icon_bytes`, served by `/favicons/:host` as before, so
this change is safe to deploy against Oxy's stages 1–4b.

### Operations

1. Oxy staff grant the Clarity Backend workload binding
   (`01a0648b-8d73-70ad-8e67-1c07ddc5eb6e`, role `oxy-clarity-task`) the
   scopes `files:app:write` and `files:references:write`. These are
   `CLARITY_FILES_SCOPES`. Clarity never deletes its own files, so it does not
   need `files:app:delete`.
2. Set the file-events endpoint in the Oxy console: Webhooks → File events →
   `https://api.clarity.surf/webhooks/oxy/files`. Store the secret shown once
   as SSM `/oxy/clarity/OXY_FILES_WEBHOOK_SECRET`, and add it to both task
   definitions in oxy-infra.
3. Deploy. Migrations `0029_oxy_files` and `0030_oxy_file_reference_triggers`
   are both `pre` and additive.

### Copying what Clarity holds

```bash
DATABASE_URL=… bun run --filter @clarity/backend images:migrate-to-oxy -- \
  --target-database=<db>                      # preview: hashes only, no writes, no Oxy calls
DATABASE_URL=… bun run --filter @clarity/backend images:migrate-to-oxy -- \
  --target-database=<db> --apply --limit=100 --report=canary.jsonl
DATABASE_URL=… bun run --filter @clarity/backend images:migrate-to-oxy -- \
  --target-database=<db> --apply --report=apply.jsonl
```

The migration copies `clarity_image_cache.bytes`, which are WebP renditions.
A row an older pipeline kept as an original is rendered first. It also copies
`clarity_search_hosts.icon_bytes`, except SVG icons.

Each upload is verified: Oxy's SHA-256 and size of what it stored must equal
Clarity's. On a mismatch the row is left untouched. A moved row gets its file
id and loses its bytes in one statement, so the migration can be interrupted
and resumed. Re-running it moves only what is left.

The migration then records the uses of entities that show a moved image:
documents and jobs whose URL matches it, if it was read in the last 30 days,
and the host of each icon. The outbox delivers them.

The report names each image by SHA-256, never by URL or host. A `blocked`
outcome means Oxy refuses those bytes after a content claim, so Clarity stops
serving them too. A `refused` or `oxy_unavailable` outcome leaves the row for a
later run.

### Soak: dual read

While a row still holds Clarity's own copy, the route serves it from Postgres
and counts a legacy read: `clarity_legacy_image_reads`, per day and surface.
The API writes these counts once a minute. Run the migration early in the soak
so that legacy reads fall to zero.

### Retiring Clarity's image storage

Gate: `images:storage-status` reports `ready` and exits 0.

```bash
DATABASE_URL=… bun run --filter @clarity/backend images:storage-status -- --target-database=<db>
```

It reports `ready` only when both of these hold:

- No `images` or `favicons` legacy read in the last 14 days.
- No cache row or non-SVG icon still holds bytes.

`favicons_svg` reads do not count against the gate.

Once the gate passes, a `post` migration drops `clarity_image_cache.bytes`,
`content_type`, `byte_size` and `rendition`. It also replaces the ready CHECK
with `status <> 'ready' or oxy_file_id is not null`. Remove the legacy branches
of `resolveImage` and `readSiteIcon` in the same change.

`clarity_search_hosts.icon_bytes` stays, restricted to `image/svg%`, until the
TODO(oxy-4c) above is done.
