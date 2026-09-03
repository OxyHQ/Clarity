import { describe, expect, it } from 'vitest';

import { buildAliaBotPath } from '../bots.js';

describe('Alia channel bot boundary', () => {
  it('builds only the exact supported channel paths', () => {
    expect(buildAliaBotPath('telegram', 'platform/:platform/link'))
      .toBe('/bots/platform/telegram/link');
    expect(buildAliaBotPath('DISCORD', 'internal/:platform/check-token/token'))
      .toBe('/bots/internal/discord/check-token/token');
  });

  it('fails closed for arbitrary channel names', () => {
    expect(buildAliaBotPath('https://attacker.test', 'platform/:platform/link')).toBeNull();
    expect(buildAliaBotPath('../telegram', 'platform/:platform/link')).toBeNull();
  });
});
