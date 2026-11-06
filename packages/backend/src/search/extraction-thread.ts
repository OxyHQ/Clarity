/**
 * The thread an {@link ExtractionPool} runs page extraction in: one request in,
 * one answer out. It owns nothing else, so the pool can terminate it the moment
 * a page outlasts its deadline.
 */
import { parentPort } from 'node:worker_threads';

import { extractDocument } from './extractor.js';
import type { ExtractionReply, ExtractionRequest } from './extraction-pool.js';

if (!parentPort) throw new Error('extraction-thread must run as a worker thread');
const port = parentPort;

port.on('message', ({ html, finalUrl }: ExtractionRequest) => {
  let reply: ExtractionReply;
  try {
    reply = { document: extractDocument(html, finalUrl) };
  } catch (error) {
    reply = { error: error instanceof Error ? error.message : String(error) };
  }
  port.postMessage(reply);
});
