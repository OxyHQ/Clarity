import {
  OxyServices,
  type ApplicationFileImport,
  type ApplicationFileUpload,
  type FileVisibility,
  type ServiceFileReference,
  type ServiceFileReferenceResult,
  type ServiceReferenceInventoryItem,
  type ServiceReferenceReconcileResult,
} from '@oxy.so/core';

/**
 * The ONE place Clarity talks to Oxy Files (ADR 0043).
 *
 * Clarity's remote images — document previews, employer logos, favicons — are
 * files the CLARITY application owns: not a person's, not billed, garbage-
 * collected by Oxy once Clarity stops referencing them (D5). Everything else in
 * Clarity reaches Oxy through this module, so a test swaps one object and the
 * scopes Clarity needs are named in one place.
 *
 * ## Scopes (granted by Oxy staff, ADR 0043 D11)
 *
 * {@link CLARITY_FILES_SCOPES}: `files:app:write` to import, upload and list its
 * own files, and `files:references:write` to say which entity uses which file.
 * Clarity never deletes a file itself — Oxy's lifecycle does — so it does not
 * ask for `files:app:delete`. They are not in the backend token's declared
 * tuple: that token is minted as exactly `CLARITY_IDENTITY.backendApplication
 * .scopes`, so a file grant never rides along on it (docs/oxy-files.md,
 * "Before the grant").
 *
 * ## SVG (Oxy stage 4c)
 *
 * Every image Clarity keeps is a file here, SVG favicons included: since stage
 * 4c Oxy accepts `image/svg+xml`, stores ONLY its sanitized document (so the
 * stored SHA-256 is the sanitized bytes', not Clarity's) and serves it inline
 * under `Content-Security-Policy: default-src 'none'; style-src
 * 'unsafe-inline'; sandbox`. {@link svgUploadRefusal} reads the two ways an SVG
 * upload is refused: an Oxy without stage 4c refuses the TYPE (415
 * `UNSUPPORTED_MEDIA_TYPE`), and Clarity keeps the icon's bytes in Postgres,
 * served by `/favicons` exactly as before; stage 4c refuses a document it cannot
 * make safe (415 `INVALID_SVG`), which is not an image Oxy will hold.
 */

/** The Oxy scopes Clarity's backend application needs for its files. */
export const CLARITY_FILES_SCOPES = Object.freeze([
  'files:app:write',
  'files:references:write',
] as const);

/** The entity kinds Clarity references files from (see `clarity_image_references`). */
export const REFERENCE_ENTITY_TYPES = ['search_document', 'job_posting', 'search_host'] as const;
export type ReferenceEntityType = (typeof REFERENCE_ENTITY_TYPES)[number];

/** Everything Clarity does with Oxy Files: a subset of `OxyServer.assets`. */
export interface OxyFiles {
  importAppFile(
    sourceUrl: string,
    options: {
      visibility: FileVisibility;
      reference?: { entityType: string; entityId: string };
      revalidate?: boolean;
    },
  ): Promise<ApplicationFileImport>;
  uploadAppFile(
    bytes: Uint8Array,
    mime: string,
    options: { visibility: FileVisibility; originalName?: string },
  ): Promise<ApplicationFileUpload>;
  references: {
    add(references: ServiceFileReference[]): Promise<ServiceFileReferenceResult[]>;
    remove(references: ServiceFileReference[]): Promise<ServiceFileReferenceResult[]>;
    reconcile(
      entityType: string,
      items: Iterable<ServiceReferenceInventoryItem> | AsyncIterable<ServiceReferenceInventoryItem>,
      options?: { dryRun?: boolean },
    ): Promise<ServiceReferenceReconcileResult>;
  };
}

let override: OxyFiles | undefined;

/**
 * The attested service identity's `assets`, loaded on first use rather than
 * imported: a module that only builds image URLs (or a test that stubs
 * `@oxy.so/core/server` down to `safeFetch`) must not pull in the service
 * identity to do it.
 */
async function serviceAssets() {
  const { getClarityFilesClient } = await import('../lib/clarity-service-auth.js');
  return getClarityFilesClient().assets;
}

const serviceFiles: OxyFiles = {
  importAppFile: async (sourceUrl, options) =>
    (await serviceAssets()).importAppFile(sourceUrl, options),
  uploadAppFile: async (bytes, mime, options) =>
    (await serviceAssets()).uploadAppFile(bytes, mime, options),
  references: {
    add: async (references) => (await serviceAssets()).references.add(references),
    remove: async (references) => (await serviceAssets()).references.remove(references),
    reconcile: async (entityType, items, options) =>
      (await serviceAssets()).references.reconcile(entityType, items, options),
  },
};

/** Clarity's Oxy Files client: the attested service identity's `assets`. */
export function oxyFiles(): OxyFiles {
  return override ?? serviceFiles;
}

/** Tests only: route every Oxy Files call to `files` (`undefined` restores the real one). */
export function setOxyFilesForTesting(files: OxyFiles | undefined): void {
  override = files;
}

/** Whether a (sniffed) content type is SVG, which Oxy stores sanitized. */
export function isSvg(contentType: string): boolean {
  return contentType.toLowerCase().startsWith('image/svg');
}

/**
 * Why Oxy refused an SVG upload, when it refused the SVG itself:
 * `type_not_supported` from an Oxy without stage 4c (the type is refused, so
 * the caller keeps the bytes it already has), `invalid_svg` from stage 4c (the
 * document is not one Oxy can sanitize). `undefined` for any other failure.
 */
export function svgUploadRefusal(error: unknown): 'type_not_supported' | 'invalid_svg' | undefined {
  const { status, code } = oxyErrorOf(error);
  if (code === 'INVALID_SVG') return 'invalid_svg';
  if (code === 'UNSUPPORTED_MEDIA_TYPE' || (status === 415 && code === undefined))
    return 'type_not_supported';
  return undefined;
}

/**
 * The public CDN address of a Clarity file, at `variant` (`w320`, `w640`,
 * `w1280`, …) or as stored. Pure: Clarity's files are all `public`.
 */
export function oxyFileUrl(fileId: string, variant?: string): string {
  urlBuilder ??= new OxyServices({ baseURL: process.env.OXY_API_URL || 'https://api.oxy.so' });
  return urlBuilder.assets.publicUrl(fileId, variant);
}

/** Builds CDN addresses only: it never sends a request. */
let urlBuilder: OxyServices | undefined;

/** The HTTP status and code an Oxy SDK call failed with, when it says. */
export function oxyErrorOf(error: unknown): { status?: number; code?: string } {
  if (typeof error !== 'object' || error === null) return {};
  const { status, code } = error as { status?: unknown; code?: unknown };
  return {
    ...(typeof status === 'number' ? { status } : {}),
    ...(typeof code === 'string' ? { code } : {}),
  };
}

/**
 * Whether an Oxy failure is about the SOURCE or the bytes — remembered as a
 * missing image — rather than about Oxy being unreachable or refusing Clarity,
 * which must never be remembered as "this image does not exist".
 */
export function isSourceFailure(error: unknown): boolean {
  const { status, code } = oxyErrorOf(error);
  if (code === 'CONTENT_BLOCKED') return false;
  return (
    code === 'INVALID_SOURCE_URL' ||
    code === 'SOURCE_URL_REFUSED' ||
    code === 'SOURCE_FETCH_FAILED' ||
    code === 'SOURCE_FETCH_TIMEOUT' ||
    code === 'UNSUPPORTED_MEDIA_TYPE' ||
    code === 'PAYLOAD_TOO_LARGE' ||
    status === 400 ||
    status === 413 ||
    status === 415 ||
    status === 422
  );
}

/** Whether Oxy refused the bytes because they were taken down (ADR 0043 D10). */
export function isBlocked(error: unknown): boolean {
  const { status, code } = oxyErrorOf(error);
  return code === 'CONTENT_BLOCKED' || status === 451;
}
