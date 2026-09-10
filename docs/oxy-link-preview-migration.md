# Oxy link preview migration

Oxy exports only resolved `link_previews` as a versioned NDJSON snapshot. The
first line is a manifest with the record count and SHA-256 of every following
record line (including its newline). Records are sorted by their legacy ID, so
repeated exports of unchanged rows are reproducible.

Export from Oxy without changing its database:

```bash
DATABASE_URL=postgresql://... bun run --filter @oxy.so/api export:clarity-link-previews -- ./oxy-link-previews.ndjson
```

Import into Clarity. This process opens only Clarity's `DATABASE_URL`, validates
the version, count, checksum and URLs before its transaction, and upserts by
canonical URL. Re-running the same snapshot is safe.

```bash
DATABASE_URL=postgresql://... bun run --filter @clarity/backend import:oxy-link-previews -- ./oxy-link-previews.ndjson
```

Compare the exporter's reported count with the importer's count before cutting
traffic over. Keep the snapshot until post-cutover search and resolve checks
confirm the imported canonical URLs and Oxy-hosted generic assets are present.
