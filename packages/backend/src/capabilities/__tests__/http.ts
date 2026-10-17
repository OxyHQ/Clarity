/**
 * Real HTTP against an Express app, with the `Host` header under the test's
 * control — the MCP lanes refuse any host but their own, and `fetch` will not
 * set one.
 */
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';

export interface HttpAnswer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  /** The JSON body, or the last `data:` frame of an event stream. */
  body: unknown;
}

export async function listen(app: Express): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function parseBody(text: string): unknown {
  const frames = text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
  const raw = frames.length > 0 ? frames[frames.length - 1] : text;
  try {
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

export function send(
  port: number,
  options: {
    method?: string;
    path: string;
    host: string;
    headers?: Record<string, string>;
    body?: unknown;
  },
): Promise<HttpAnswer> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'POST',
        path: options.path,
        headers: {
          host: options.host,
          ...(payload ? { 'content-type': 'application/json' } : {}),
          ...options.headers,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text,
            body: parseBody(text),
          }),
        );
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export function rpc(
  port: number,
  host: string,
  method: string,
  params: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<HttpAnswer> {
  return send(port, {
    path: '/_oxy/mcp',
    host,
    headers: { accept: 'application/json, text/event-stream', ...headers },
    body: { jsonrpc: '2.0', id: 1, method, params },
  });
}
