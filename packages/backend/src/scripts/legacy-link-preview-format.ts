import { createHash } from 'node:crypto';

export const LEGACY_LINK_PREVIEW_FORMAT = 'oxy-link-previews';
export const LEGACY_LINK_PREVIEW_VERSION = 1;

export interface LegacyLinkPreviewRecord {
  type: 'link_preview';
  id: string;
  requestedUrl: string;
  canonicalUrl: string;
  title: string | null;
  description: string | null;
  siteName: string | null;
  faviconUrl: string | null;
  imageUrl: string | null;
  resolverVersion: number;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LegacyLinkPreviewManifest {
  type: 'manifest';
  format: typeof LEGACY_LINK_PREVIEW_FORMAT;
  version: typeof LEGACY_LINK_PREVIEW_VERSION;
  recordCount: number;
  recordsSha256: string;
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

function isTimestamp(value: unknown, nullable = false): value is string | null {
  return (nullable && value === null)
    || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
}

export function parseLegacyLinkPreviewExport(input: string): {
  manifest: LegacyLinkPreviewManifest;
  records: LegacyLinkPreviewRecord[];
} {
  const lines = input.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) throw new Error('The export is empty');

  const manifest = JSON.parse(lines[0]) as Partial<LegacyLinkPreviewManifest>;
  if (
    manifest.type !== 'manifest'
    || manifest.format !== LEGACY_LINK_PREVIEW_FORMAT
    || manifest.version !== LEGACY_LINK_PREVIEW_VERSION
    || !Number.isSafeInteger(manifest.recordCount)
    || typeof manifest.recordsSha256 !== 'string'
  ) {
    throw new Error('Unsupported or malformed link preview manifest');
  }

  const recordLines = lines.slice(1);
  if (recordLines.length !== manifest.recordCount) {
    throw new Error(`Record count mismatch: expected ${manifest.recordCount}, received ${recordLines.length}`);
  }
  const checksum = createHash('sha256')
    .update(recordLines.map((line) => `${line}\n`).join(''))
    .digest('hex');
  if (checksum !== manifest.recordsSha256) throw new Error('Record checksum mismatch');

  const records = recordLines.map((line, index) => {
    const record = JSON.parse(line) as Partial<LegacyLinkPreviewRecord>;
    if (
      record.type !== 'link_preview'
      || typeof record.id !== 'string'
      || typeof record.requestedUrl !== 'string'
      || typeof record.canonicalUrl !== 'string'
      || !isNullableString(record.title)
      || !isNullableString(record.description)
      || !isNullableString(record.siteName)
      || !isNullableString(record.faviconUrl)
      || !isNullableString(record.imageUrl)
      || typeof record.resolverVersion !== 'number'
      || !Number.isSafeInteger(record.resolverVersion)
      || !isTimestamp(record.resolvedAt, true)
      || !isTimestamp(record.createdAt)
      || !isTimestamp(record.updatedAt)
    ) {
      throw new Error(`Malformed link preview record at line ${index + 2}`);
    }
    new URL(record.requestedUrl);
    new URL(record.canonicalUrl);
    return record as LegacyLinkPreviewRecord;
  });

  return { manifest: manifest as LegacyLinkPreviewManifest, records };
}
