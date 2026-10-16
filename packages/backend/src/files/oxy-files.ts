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
 * The ONE place Clarity talks to Oxy Files (ADR 0041).
 *
 * Clarity's remote images — document previews, employer logos, favicons — are
 * files the CLARITY application owns: not a person's, not billed, garbage-
 * collected by Oxy once Clarity stops referencing them (D5). Everything else in
 * Clarity reaches Oxy through this module, so a test swaps one object and the
 * scopes Clarity needs are named in one place.
 *
 * ## Scopes (granted by Oxy staff, ADR 0041 D11)
 *
 * {@link CLARITY_FILES_SCOPES}: `files:app:write` to import, upload and list its
 * own files, and `files:references:write` to say which entity uses which file.
 * Clarity never deletes a file itself — Oxy's lifecycle does — so it does not
 * ask for `files:app:delete`. These are NOT agent scopes: the token Clarity
 * sends to Alia must stay exactly `CLARITY_AGENT_MANIFEST.backendApplication
 * .scopes` (docs/oxy-files.md, "Before the grant").
 *
 * ## What Oxy cannot hold yet — TODO(oxy-4b)
 *
 * Oxy accepts an application file only when it is an image or a video, at most
 * 40 MiB, and never `image/svg*` (refused as a stored-XSS vector by the API's
 * `isAllowedCacheMime`). Every Clarity image is far below the size cap (5 MiB
 * previews, 100 KiB icons), so the one thing that does not fit is an SVG
 * favicon: {@link oxyCanHold} says no, and `site-icons.ts` keeps those bytes in
 * `clarity_search_hosts.icon_bytes`, served by `/favicons` under its sandbox
 * CSP, exactly as before. TODO(oxy-4b): when Oxy's stage 4b stores any type
 * (and serves an SVG inertly), drop this branch, upload SVG icons like every
 * other icon, and let the retirement step drop `icon_bytes`.
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

/**
 * Whether Oxy Files can hold bytes of this (sniffed) type. Only an SVG cannot
 * today — see the module header, TODO(oxy-4b).
 */
export function oxyCanHold(contentType: string): boolean {
  const type = contentType.toLowerCase();
  return (type.startsWith('image/') || type.startsWith('video/')) && !type.startsWith('image/svg');
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

/** Whether Oxy refused the bytes because they were taken down (ADR 0041 D10). */
export function isBlocked(error: unknown): boolean {
  const { status, code } = oxyErrorOf(error);
  return code === 'CONTENT_BLOCKED' || status === 451;
}
