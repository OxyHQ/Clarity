/**
 * The catalogue's own invariants — what Oxy will accept, and what Clarity
 * promises about every tool.
 */
import { appCapabilityCatalogSchema } from '@oxy.so/contracts';
import { capabilityCatalogDigest } from '@oxy.so/mcp';
import { describe, expect, it } from 'vitest';

import { CLARITY_CAPABILITY_CATALOG } from '../clarity.catalog.js';
import { CLARITY_INVOCATION_HANDLERS } from '../clarity.handlers.js';
import { EXCLUDED_ROUTES } from '../exclusions.js';

const catalog = CLARITY_CAPABILITY_CATALOG;

/**
 * The registered identity of the catalogue. Oxy registers by (appId, version,
 * digest), so a tool changed without a version bump is a registration Oxy
 * refuses at boot. When this fails: bump `version` in `clarity.catalog.ts` and
 * copy the new pair here.
 */
const PINNED = {
  version: '1.0.0',
  digest: 'a77e444b5c59c6f975e10ceb00d17c942c6891f7df9fd42adc3b2382eb2996fe',
};

describe('CLARITY_CAPABILITY_CATALOG', () => {
  it('is a catalogue Oxy accepts', () => {
    expect(() => appCapabilityCatalogSchema.parse(catalog)).not.toThrow();
  });

  it('declares the identity Alia and the OAuth lane bind to', () => {
    expect(catalog).toMatchObject({
      appId: 'clarity',
      audience: 'oxy-clarity-api',
      internalBaseUrl: 'https://api.clarity.surf',
      internalTransport: 'mcp',
      accountResourceType: 'clarity_account',
      externalMcp: { resource: 'https://mcp.clarity.surf' },
    });
  });

  it('pins its version to its digest', () => {
    expect({ version: catalog.version, digest: capabilityCatalogDigest(catalog) }).toEqual(PINNED);
  });

  it('declares exactly the plan features Alia may gate on, each with an internal check', () => {
    expect(catalog.features?.map((feature) => feature.key)).toEqual([
      'deep_research',
      'power_level.high',
      'power_level.xhigh',
      'power_level.pro',
      'power_level.ultra',
    ]);
    for (const feature of catalog.features ?? []) {
      const check = catalog.tools.find((tool) => tool.name === feature.checkTool);
      expect(check).toMatchObject({ effect: 'read', exposure: ['internal'] });
      // Not metered: the inference is paid by the person's Alia credits.
      expect(feature.consumeTool).toBeUndefined();
    }
  });

  it('acts on the account root only and never asks for a sensitive package', () => {
    for (const tool of catalog.tools) {
      expect(tool.resourceTypes).toEqual(['clarity_account']);
      expect(['finance', 'security', 'delegate']).not.toContain(tool.capabilityPackage);
      expect(['financial', 'security']).not.toContain(tool.effect);
    }
  });

  it('gives every effect an idempotency contract and every read none', () => {
    for (const tool of catalog.tools) {
      if (tool.effect === 'read') expect(tool.idempotency).toBe('none');
      else expect(['supported', 'required']).toContain(tool.idempotency);
    }
  });

  it('has one handler per tool and no input that names an account', () => {
    expect(Object.keys(CLARITY_INVOCATION_HANDLERS).sort()).toEqual(
      catalog.tools.map((tool) => tool.name).sort(),
    );
    for (const tool of catalog.tools) {
      const properties = Object.keys(
        (tool.inputSchema.properties as Record<string, unknown> | undefined) ?? {},
      );
      for (const forbidden of ['accountId', 'userId', 'oxyUserId', 'effectiveAccountId']) {
        expect(properties).not.toContain(forbidden);
      }
    }
  });

  it('offers no publisher, billing or administration action under any name', () => {
    const names = catalog.tools.map((tool) => tool.name.toLowerCase());
    const forbidden = [
      'index',
      'crawl',
      'site',
      'jobfeed',
      'ingest',
      'operation',
      'quota',
      'usage',
    ];
    forbidden.push('checkout', 'subscription', 'portal', 'credit', 'push');
    for (const word of forbidden) {
      expect(names.filter((name) => name.includes(word))).toEqual([]);
    }
    expect(Object.keys(EXCLUDED_ROUTES).length).toBeGreaterThan(0);
  });
});
