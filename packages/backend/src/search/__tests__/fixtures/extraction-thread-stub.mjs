// A stand-in for extraction-thread.ts: answers with the page's length, spins
// forever on "spin", crashes the thread on "crash". Plain JS so Node can load it.
import { parentPort } from 'node:worker_threads';

parentPort.on('message', ({ html }) => {
  if (html === 'spin') for (;;);
  if (html === 'crash') throw new Error('boom');
  parentPort.postMessage({ document: { title: `len:${html.length}` } });
});
