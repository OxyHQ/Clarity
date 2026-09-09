import type {
  ClarityErrorBody, CreateSiteRequest, Document, IndexUrlsRequest, Job, NewsRequest, NewsStory,
  Page, Quotas, RequestOptions, ResolveRequest, ResolveResult, SearchRequest, SearchResponse, Site,
  UpdateSiteRequest, UsageBucket,
} from './types.js';

export class ClarityError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly requestId: string,
    readonly details?: Record<string, unknown>,
  ) { super(message); this.name = 'ClarityError'; }
}

export interface ClarityClientOptions {
  apiKey?: string;
  accessToken?: string;
  getAccessToken?: () => string | Promise<string>;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://api.clarity.surf';
const DEFAULT_TIMEOUT_MS = 15_000;
const SAFE_RETRY_DELAYS_MS = [250, 1000] as const;

export class ClarityClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: ClarityClientOptions) {
    const authMethods = [options.apiKey, options.accessToken, options.getAccessToken].filter(Boolean);
    if (authMethods.length !== 1) throw new Error('Configure exactly one of apiKey, accessToken or getAccessToken');
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetcher = options.fetch ?? globalThis.fetch;
    if (!this.fetcher) throw new Error('A Fetch API implementation is required');
  }

  readonly search = (request: SearchRequest, options?: RequestOptions) =>
    this.request<SearchResponse>('POST', '/v1/search', request, options);

  readonly news = (request: NewsRequest = {}, options?: RequestOptions) =>
    this.request<Page<NewsStory>>('GET', `/v1/news${query(request)}`, undefined, options);

  readonly documents = {
    get: (id: string, options?: RequestOptions) => this.request<Document>('GET', `/v1/documents/${encodeURIComponent(id)}`, undefined, options),
    byUrl: (url: string, options?: RequestOptions) => this.request<Document>('GET', `/v1/documents/by-url${query({ url })}`, undefined, options),
  };

  readonly indexing = {
    urls: (request: IndexUrlsRequest, options: RequestOptions) => this.request<Job>('POST', '/v1/index/urls', request, options),
    resolve: (request: ResolveRequest, options?: RequestOptions) => this.request<{ data: ResolveResult[] }>('POST', '/v1/resolve', request, options),
  };

  readonly sites = {
    list: (cursor?: string, options?: RequestOptions) => this.request<Page<Site>>('GET', `/v1/sites${query({ cursor })}`, undefined, options),
    create: (request: CreateSiteRequest, options: RequestOptions) => this.request<Site>('POST', '/v1/sites', request, options),
    update: (id: string, request: UpdateSiteRequest, options: RequestOptions) => this.request<Site>('PATCH', `/v1/sites/${encodeURIComponent(id)}`, request, options),
    crawl: (id: string, options: RequestOptions) => this.request<Job>('POST', `/v1/sites/${encodeURIComponent(id)}/crawls`, {}, options),
    removeDocument: (id: string, documentId: string, options: RequestOptions) => this.request<Job>('POST', `/v1/sites/${encodeURIComponent(id)}/removals`, { documentId }, options),
  };

  readonly jobs = {
    get: (id: string, options?: RequestOptions) => this.request<Job>('GET', `/v1/jobs/${encodeURIComponent(id)}`, undefined, options),
    cancel: (id: string, options: RequestOptions) => this.request<Job>('POST', `/v1/jobs/${encodeURIComponent(id)}/cancel`, {}, options),
    wait: async (id: string, options: RequestOptions & { intervalMs?: number } = {}): Promise<Job> => {
      while (true) {
        const job = await this.request<Job>('GET', `/v1/jobs/${encodeURIComponent(id)}`, undefined, options);
        if (['succeeded', 'partial', 'failed', 'cancelled'].includes(job.status)) return job;
        await delay(options.intervalMs ?? 1000, options.signal);
      }
    },
  };

  readonly usage = {
    get: (cursor?: string, options?: RequestOptions) => this.request<Page<UsageBucket>>('GET', `/v1/usage${query({ cursor })}`, undefined, options),
    quotas: (options?: RequestOptions) => this.request<Quotas>('GET', '/v1/quotas', undefined, options),
  };

  private async token(): Promise<string> {
    if (this.options.apiKey) return this.options.apiKey;
    if (this.options.accessToken) return this.options.accessToken;
    const token = await this.options.getAccessToken?.();
    if (!token) throw new Error('getAccessToken returned no token');
    return token;
  }

  private async request<T>(method: string, path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    const safe = method === 'GET';
    const attempts = safe ? SAFE_RETRY_DELAYS_MS.length + 1 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const onAbort = () => controller.abort(options.signal?.reason);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const response = await this.fetcher(`${this.baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${await this.token()}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        if (response.ok) return await response.json() as T;
        if (safe && attempt + 1 < attempts && (response.status === 429 || response.status >= 500)) {
          await delay(retryDelay(response, attempt), options.signal);
          continue;
        }
        const payload = await response.json().catch(() => undefined) as ClarityErrorBody | undefined;
        throw new ClarityError(payload?.error.message ?? `Clarity request failed with ${response.status}`, payload?.error.code ?? 'request_failed', response.status, payload?.error.requestId ?? response.headers.get('x-request-id') ?? 'unknown', payload?.error.details);
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', onAbort);
      }
    }
    throw new Error('Unreachable retry state');
  }
}

function query(values: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((item) => params.append(key, String(item)));
    else params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter && /^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000;
  return SAFE_RETRY_DELAYS_MS[attempt] ?? SAFE_RETRY_DELAYS_MS[SAFE_RETRY_DELAYS_MS.length - 1];
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => { clearTimeout(timeout); reject(signal.reason); }, { once: true });
  });
}
