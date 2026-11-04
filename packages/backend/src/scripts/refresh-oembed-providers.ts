#!/usr/bin/env bun
/**
 * Refreshes `src/search/oembed-providers.generated.json` from the official
 * oEmbed provider registry (https://oembed.com/providers.json).
 *
 *   bun run --filter @clarity/backend oembed:refresh
 *
 * Keeps each endpoint that lists URL schemes and answers JSON, with `{format}`
 * filled in, sorted by provider name so a refresh diffs cleanly. Review the
 * diff before committing it: the registry is community-maintained.
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const REGISTRY_URL = 'https://oembed.com/providers.json';
const OUTPUT = fileURLToPath(new URL('../search/oembed-providers.generated.json', import.meta.url));

interface RegistryEndpoint {
  url?: unknown;
  schemes?: unknown;
  formats?: unknown;
}

interface RegistryProvider {
  provider_name?: unknown;
  endpoints?: RegistryEndpoint[];
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const response = await fetch(REGISTRY_URL);
if (!response.ok) throw new Error(`${REGISTRY_URL} answered ${response.status}`);
const registry = (await response.json()) as RegistryProvider[];
const providers = registry
  .flatMap((provider) =>
    (provider.endpoints ?? []).flatMap((endpoint) => {
      const schemes = strings(endpoint.schemes);
      const formats = strings(endpoint.formats);
      if (typeof provider.provider_name !== 'string' || typeof endpoint.url !== 'string') return [];
      if (schemes.length === 0 || (formats.length > 0 && !formats.includes('json'))) return [];
      return [
        {
          name: provider.provider_name,
          endpoint: endpoint.url.replace('{format}', 'json'),
          schemes,
        },
      ];
    }),
  )
  .sort((a, b) => a.name.localeCompare(b.name) || a.endpoint.localeCompare(b.endpoint));
await writeFile(OUTPUT, `${JSON.stringify(providers, null, 1)}\n`);
console.info(`${providers.length} oEmbed endpoints written to ${OUTPUT}`);
