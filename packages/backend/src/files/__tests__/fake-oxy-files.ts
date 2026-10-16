import { createHash } from 'node:crypto';
import type {
  ApplicationFile,
  ServiceFileReference,
  ServiceFileReferenceResult,
  ServiceReferenceInventoryItem,
} from '@oxy.so/core';

import type { OxyFiles } from '../oxy-files.js';

/** An Oxy SDK failure as `HttpService` rejects with it. */
export function oxyError(status: number, code: string): Error {
  return Object.assign(new Error(code), { status, code });
}

/**
 * An in-memory Oxy Files with the semantics Clarity relies on: per-application
 * dedupe by bytes and by source URL, references that `not_found` a deleted
 * file, reconciliation of one entity type. Never touches the network.
 */
export class FakeOxyFiles implements OxyFiles {
  files = new Map<string, ApplicationFile & { bytes: Buffer }>();
  sources = new Map<string, string>();
  references = {
    add: async (items: ServiceFileReference[]) => this.change('add', items),
    remove: async (items: ServiceFileReference[]) => this.change('remove', items),
    reconcile: async (
      entityType: string,
      items: Iterable<ServiceReferenceInventoryItem> | AsyncIterable<ServiceReferenceInventoryItem>,
      options: { dryRun?: boolean } = {},
    ) => {
      this.calls.push(`reconcile:${entityType}`);
      const wanted = new Set<string>();
      for await (const item of items) wanted.add(`${item.fileId}|${entityType}|${item.entityId}`);
      const held = [...this.refs].filter((ref) => ref.split('|')[1] === entityType);
      const added = [...wanted].filter(
        (ref) => !this.refs.has(ref) && this.live(ref.split('|')[0]),
      );
      const removed = held.filter((ref) => !wanted.has(ref));
      if (!options.dryRun) {
        for (const ref of added) this.refs.add(ref);
        for (const ref of removed) this.refs.delete(ref);
      }
      return {
        sessionId: 'fake',
        entityType,
        dryRun: options.dryRun === true,
        added: added.length,
        removed: removed.length,
        unchanged: held.length - removed.length,
        refused: [...wanted].filter((ref) => !this.live(ref.split('|')[0])).length,
      };
    },
  };
  refs = new Set<string>();
  calls: string[] = [];
  /** Source URL → bytes the fake "fetches", or an error to throw. */
  remote = new Map<string, Buffer | Error>();
  /** When set, every call throws it (Oxy unreachable). */
  down: Error | undefined;
  private next = 1;

  private live(fileId: string): boolean {
    return this.files.get(fileId)?.status === 'active';
  }

  private change(
    op: 'add' | 'remove',
    items: ServiceFileReference[],
  ): ServiceFileReferenceResult[] {
    if (this.down) throw this.down;
    this.calls.push(`${op}:${items.map((i) => `${i.entityType}/${i.entityId}`).join(',')}`);
    return items.map((item) => {
      const key = `${item.fileId}|${item.entityType}|${item.entityId}`;
      if (op === 'add') {
        if (!this.files.has(item.fileId)) return { ...item, result: 'not_found' };
        const file = this.files.get(item.fileId);
        if (file && file.status === 'trash') file.status = 'active';
        if (this.refs.has(key)) return { ...item, result: 'exists' };
        this.refs.add(key);
        return { ...item, result: 'created' };
      }
      return { ...item, result: this.refs.delete(key) ? 'removed' : 'not_found' };
    });
  }

  private store(bytes: Buffer, mime: string): { file: ApplicationFile; deduplicated: boolean } {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const existing = [...this.files.values()].find((file) => file.sha256 === sha256);
    if (existing) {
      const { bytes: _bytes, ...file } = existing;
      return { file, deduplicated: true };
    }
    const id = `file-${this.next++}`;
    const now = new Date().toISOString();
    const file: ApplicationFile = {
      id,
      sha256,
      size: bytes.length,
      mime,
      ext: mime.split('/')[1] ?? 'bin',
      ownerApplicationId: 'clarity',
      status: 'active',
      visibility: 'public',
      createdAt: now,
      updatedAt: now,
    };
    this.files.set(id, { ...file, bytes });
    return { file, deduplicated: false };
  }

  async uploadAppFile(bytes: Uint8Array, mime: string) {
    if (this.down) throw this.down;
    this.calls.push(`upload:${mime}`);
    if (mime.startsWith('image/svg')) throw oxyError(415, 'UNSUPPORTED_MEDIA_TYPE');
    return this.store(Buffer.from(bytes), mime);
  }

  async importAppFile(
    sourceUrl: string,
    options: { reference?: { entityType: string; entityId: string }; revalidate?: boolean },
  ) {
    if (this.down) throw this.down;
    this.calls.push(`import:${options.revalidate ? 'revalidate' : 'first'}`);
    if (!sourceUrl.startsWith('https:')) throw oxyError(400, 'INVALID_SOURCE_URL');
    const known = this.sources.get(sourceUrl);
    if (known && this.live(known) && !options.revalidate) {
      const { bytes: _bytes, ...file } = this.files.get(known) as ApplicationFile & {
        bytes: Buffer;
      };
      return {
        file,
        outcome: 'existing' as const,
        deduplicated: true,
        source: { host: 'example', fetchedAt: new Date().toISOString() },
        ...(options.reference ? { reference: this.referenceFor(file.id, options.reference) } : {}),
      };
    }
    const remote = this.remote.get(sourceUrl);
    if (!remote) throw oxyError(502, 'SOURCE_FETCH_FAILED');
    if (remote instanceof Error) throw remote;
    const { file, deduplicated } = this.store(remote, 'image/png');
    this.sources.set(sourceUrl, file.id);
    return {
      file,
      outcome: 'downloaded' as const,
      deduplicated,
      source: { host: 'example', fetchedAt: new Date().toISOString() },
      ...(options.reference ? { reference: this.referenceFor(file.id, options.reference) } : {}),
    };
  }

  private referenceFor(fileId: string, reference: { entityType: string; entityId: string }) {
    const key = `${fileId}|${reference.entityType}|${reference.entityId}`;
    const existed = this.refs.has(key);
    this.refs.add(key);
    return { result: existed ? ('exists' as const) : ('created' as const) };
  }

  /** Oxy's D5 sweep and purge, by hand. */
  trash(fileId: string): void {
    const file = this.files.get(fileId);
    if (file) file.status = 'trash';
  }

  purge(fileId: string): void {
    this.files.delete(fileId);
    for (const ref of [...this.refs]) if (ref.startsWith(`${fileId}|`)) this.refs.delete(ref);
    for (const [url, id] of this.sources) if (id === fileId) this.sources.delete(url);
  }

  referencesOf(entityType: string, entityId: string): string[] {
    return [...this.refs]
      .filter((ref) => ref.endsWith(`|${entityType}|${entityId}`))
      .map((ref) => ref.split('|')[0]);
  }
}
