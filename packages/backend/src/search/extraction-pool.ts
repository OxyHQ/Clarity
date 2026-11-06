/**
 * Page extraction off the main thread, with a deadline.
 *
 * `extractDocument` (linkedom + Readability) is synchronous and its cost grows
 * with the page: a huge or deeply nested DOM can keep one thread busy for
 * minutes. Run on the crawl worker's own thread, such a page stops everything
 * that thread does — page leases, heartbeats, the other loops — and nothing
 * inside the process can interrupt it. Here each extraction runs in a pool
 * thread, and a page that outlasts {@link ExtractionPoolOptions.timeoutMs} has
 * its thread terminated and replaced: the page fails, the worker carries on.
 *
 * Threads are started on demand, run one extraction at a time, and are reused.
 */
import { Worker } from 'node:worker_threads';

import type { ExtractedDocument } from './extractor.js';

export interface ExtractionRequest {
  html: string;
  finalUrl: string;
}

export type ExtractionReply = { document: ExtractedDocument } | { error: string };

/** The page outlasted its deadline; its thread was terminated. Asking again would repeat it. */
export class ExtractionTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`extraction_timeout: page extraction exceeded ${timeoutMs} ms`);
    this.name = 'ExtractionTimeoutError';
  }
}

export interface ExtractionPoolOptions {
  /** The thread's entry module (`extraction-thread`). */
  entry: URL;
  /** Threads that extract at the same time. */
  size: number;
  /** Longest a single extraction may run. */
  timeoutMs: number;
}

interface Task {
  request: ExtractionRequest;
  resolve: (document: ExtractedDocument) => void;
  reject: (error: Error) => void;
}

interface Slot {
  worker: Worker;
  task?: Task;
  timer?: ReturnType<typeof setTimeout>;
}

export class ExtractionPool {
  private readonly slots: Slot[] = [];
  private readonly queue: Task[] = [];
  private closed = false;

  constructor(private readonly options: ExtractionPoolOptions) {
    if (options.size < 1) throw new Error('ExtractionPool needs at least one thread');
  }

  extract(html: string, finalUrl: string): Promise<ExtractedDocument> {
    if (this.closed) return Promise.reject(new Error('ExtractionPool is closed'));
    return new Promise((resolve, reject) => {
      this.queue.push({ request: { html, finalUrl }, resolve, reject });
      this.dispatch();
    });
  }

  /** Reject what is waiting or running and stop every thread. */
  async close(): Promise<void> {
    this.closed = true;
    const error = new Error('ExtractionPool is closed');
    for (const task of this.queue.splice(0)) task.reject(error);
    await Promise.all(this.slots.splice(0).map((slot) => this.retire(slot, error)));
  }

  private dispatch(): void {
    while (this.queue.length > 0) {
      const slot = this.idleSlot();
      if (!slot) return;
      const task = this.queue.shift() as Task;
      slot.task = task;
      slot.timer = setTimeout(
        () => void this.retire(slot, new ExtractionTimeoutError(this.options.timeoutMs)),
        this.options.timeoutMs,
      );
      slot.worker.postMessage(task.request);
    }
  }

  private idleSlot(): Slot | undefined {
    const idle = this.slots.find((slot) => !slot.task);
    if (idle) return idle;
    return this.slots.length < this.options.size ? this.spawn() : undefined;
  }

  private spawn(): Slot {
    const worker = new Worker(this.options.entry);
    const slot: Slot = { worker };
    worker.on('message', (reply: ExtractionReply) => {
      const task = this.release(slot);
      if (!task) return;
      if ('error' in reply) task.reject(new Error(reply.error));
      else task.resolve(reply.document);
      this.dispatch();
    });
    // A thread that crashed or exited on its own is replaced like a timed-out one.
    worker.on('error', (error: Error) => void this.retire(slot, error));
    worker.on('exit', (code) => {
      if (this.slots.includes(slot))
        void this.retire(slot, new Error(`extraction thread exited with code ${code}`));
    });
    this.slots.push(slot);
    return slot;
  }

  /** Take the running task off a slot and stop its deadline. */
  private release(slot: Slot): Task | undefined {
    clearTimeout(slot.timer);
    const task = slot.task;
    slot.task = undefined;
    slot.timer = undefined;
    return task;
  }

  /** Remove a slot, stop its thread and fail the task it was running. */
  private async retire(slot: Slot, error: Error): Promise<void> {
    const index = this.slots.indexOf(slot);
    if (index !== -1) this.slots.splice(index, 1);
    this.release(slot)?.reject(error);
    await slot.worker.terminate();
    this.dispatch();
  }
}

/** Threads sharing the worker's CPU with its crawl loop: more only queue behind each other. */
const DEFAULT_THREADS = 2;
/** Readability takes well under a second on a normal page; this is for the pathological one. */
const DEFAULT_TIMEOUT_MS = 20_000;

let shared: ExtractionPool | undefined;

function sharedPool(): ExtractionPool {
  shared ??= new ExtractionPool({
    // Resolved against this module in source and against the bundle in `dist/`,
    // where build.ts emits the thread as `dist/extraction-thread.js`.
    entry: new URL(import.meta.resolve('./extraction-thread.js')),
    size: Number.parseInt(process.env.EXTRACTION_THREADS ?? '', 10) || DEFAULT_THREADS,
    timeoutMs: Number.parseInt(process.env.EXTRACTION_TIMEOUT_MS ?? '', 10) || DEFAULT_TIMEOUT_MS,
  });
  return shared;
}

/** {@link extractDocument}, run in the shared pool under its deadline. */
export function extractDocumentInThread(
  html: string,
  finalUrl: string,
): Promise<ExtractedDocument> {
  return sharedPool().extract(html, finalUrl);
}

export async function closeExtractionPool(): Promise<void> {
  const pool = shared;
  shared = undefined;
  await pool?.close();
}
