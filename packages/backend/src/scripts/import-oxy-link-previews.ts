import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb } from '../db/index.js';
import { searchDocumentAliases, searchDocuments } from '../db/schema/index.js';
import { parseLegacyLinkPreviewExport } from './legacy-link-preview-format.js';

function documentId(canonicalUrl: string): string {
  return `legacy_oxy_${createHash('sha256').update(canonicalUrl).digest('hex')}`;
}

function date(value: string | null): Date | undefined {
  return value ? new Date(value) : undefined;
}

async function main(): Promise<void> {
  const inputArgument = process.argv[2];
  if (!inputArgument) throw new Error('Usage: bun import:oxy-link-previews <export.ndjson>');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  const { manifest, records } = parseLegacyLinkPreviewExport(await readFile(resolve(inputArgument), 'utf8'));
  connectPostgres(process.env.DATABASE_URL);
  const database = getDb();

  await database.transaction(async (transaction) => {
    for (const record of records) {
      const id = documentId(record.canonicalUrl);
      const importedAt = date(record.resolvedAt) ?? date(record.updatedAt) ?? new Date();
      const [document] = await transaction.insert(searchDocuments).values({
        id,
        requestedUrl: record.requestedUrl,
        finalUrl: record.canonicalUrl,
        canonicalUrl: record.canonicalUrl,
        status: 'indexed',
        documentType: 'page',
        title: record.title,
        description: record.description,
        publisherName: record.siteName,
        imageUrl: record.imageUrl,
        faviconUrl: record.faviconUrl,
        structuredData: [{ source: 'oxy_link_preview', resolverVersion: record.resolverVersion }],
        fieldEvidence: { import: { format: manifest.format, version: manifest.version, sourceId: record.id } },
        fetchedAt: importedAt,
        indexedAt: importedAt,
      }).onConflictDoUpdate({
        target: searchDocuments.canonicalUrl,
        set: {
          requestedUrl: record.requestedUrl,
          finalUrl: record.canonicalUrl,
          status: 'indexed',
          title: record.title,
          description: record.description,
          publisherName: record.siteName,
          imageUrl: record.imageUrl,
          faviconUrl: record.faviconUrl,
          structuredData: [{ source: 'oxy_link_preview', resolverVersion: record.resolverVersion }],
          fieldEvidence: { import: { format: manifest.format, version: manifest.version, sourceId: record.id } },
          fetchedAt: importedAt,
          indexedAt: importedAt,
          updatedAt: new Date(),
        },
      }).returning({ id: searchDocuments.id });
      if (!document) throw new Error(`Document upsert returned no row for ${record.canonicalUrl}`);
      await transaction.insert(searchDocumentAliases).values({
        url: record.requestedUrl,
        documentId: document.id,
        kind: 'requested',
      }).onConflictDoUpdate({
        target: searchDocumentAliases.url,
        set: { documentId: document.id, kind: 'requested', discoveredAt: sql`now()` },
      });
    }
  });

  process.stdout.write(`Imported ${records.length} resolved Oxy link previews.\n`);
}

void main()
  .catch((error: unknown) => {
    process.stderr.write(`Import failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(closePostgres);
