import { afterEach, describe, expect, it } from 'vitest';
import { ExtractionPool, ExtractionTimeoutError } from '../extraction-pool.js';

const entry = new URL('./fixtures/extraction-thread-stub.mjs', import.meta.url);
let pool: ExtractionPool | undefined;

function open(timeoutMs = 1_000, size = 1): ExtractionPool {
  pool = new ExtractionPool({ entry, size, timeoutMs });
  return pool;
}

afterEach(async () => {
  await pool?.close();
  pool = undefined;
});

describe('ExtractionPool', () => {
  it('answers from a thread', async () => {
    await expect(open().extract('abc', 'https://e.test')).resolves.toMatchObject({
      title: 'len:3',
    });
  });

  it('terminates a page that never finishes and serves the next one', async () => {
    const p = open(300);
    await expect(p.extract('spin', 'https://e.test')).rejects.toBeInstanceOf(
      ExtractionTimeoutError,
    );
    await expect(p.extract('after', 'https://e.test')).resolves.toMatchObject({ title: 'len:5' });
  });

  it('keeps other pages moving while one spins', async () => {
    const p = open(500, 2);
    const spinning = p.extract('spin', 'https://e.test').catch((error) => error);
    await expect(p.extract('quick', 'https://e.test')).resolves.toMatchObject({ title: 'len:5' });
    expect(await spinning).toBeInstanceOf(ExtractionTimeoutError);
  });

  it('replaces a thread that crashed', async () => {
    const p = open();
    await expect(p.extract('crash', 'https://e.test')).rejects.toThrow('boom');
    await expect(p.extract('ok', 'https://e.test')).resolves.toMatchObject({ title: 'len:2' });
  });

  it('rejects work after close', async () => {
    const p = open();
    await p.close();
    await expect(p.extract('x', 'https://e.test')).rejects.toThrow('closed');
  });
});
