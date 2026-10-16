import { describe, expect, it } from 'vitest';

import { CLARITY_AGENT_MANIFEST } from '../../lib/clarity-agent-manifest.js';
import {
  CLARITY_FILES_SCOPES,
  isBlocked,
  isSourceFailure,
  isSvg,
  oxyFileUrl,
  svgUploadRefusal,
} from '../oxy-files.js';
import { oxyError } from './fake-oxy-files.js';

describe('the Oxy Files adapter', () => {
  it('asks for exactly the files scopes it uses, none of them an agent scope', () => {
    expect(CLARITY_FILES_SCOPES).toEqual(['files:app:write', 'files:references:write']);
    for (const scope of CLARITY_FILES_SCOPES)
      expect(CLARITY_AGENT_MANIFEST.backendApplication.scopes).not.toContain(scope);
  });

  it('reads an SVG refusal: an Oxy without stage 4c refuses the type, stage 4c an unsafe document', () => {
    expect(isSvg('image/svg+xml')).toBe(true);
    for (const type of ['image/png', 'image/x-icon', 'image/webp']) expect(isSvg(type)).toBe(false);
    expect(svgUploadRefusal(oxyError(415, 'UNSUPPORTED_MEDIA_TYPE'))).toBe('type_not_supported');
    expect(svgUploadRefusal(oxyError(415, 'INVALID_SVG'))).toBe('invalid_svg');
    // Anything else is not about the SVG: a takedown, an unreachable Oxy, a refusal of Clarity.
    expect(svgUploadRefusal(oxyError(451, 'CONTENT_BLOCKED'))).toBeUndefined();
    expect(svgUploadRefusal(oxyError(503, 'SERVICE_UNAVAILABLE'))).toBeUndefined();
    expect(svgUploadRefusal(oxyError(403, 'FORBIDDEN'))).toBeUndefined();
    expect(svgUploadRefusal(new Error('network down'))).toBeUndefined();
  });

  it('tells a failed source from an unreachable Oxy, and a takedown from both', () => {
    expect(isSourceFailure(oxyError(502, 'SOURCE_FETCH_FAILED'))).toBe(true);
    expect(isSourceFailure(oxyError(504, 'SOURCE_FETCH_TIMEOUT'))).toBe(true);
    expect(isSourceFailure(oxyError(422, 'SOURCE_URL_REFUSED'))).toBe(true);
    expect(isSourceFailure(oxyError(413, 'PAYLOAD_TOO_LARGE'))).toBe(true);
    expect(isSourceFailure(oxyError(503, 'SERVICE_UNAVAILABLE'))).toBe(false);
    expect(isSourceFailure(oxyError(403, 'FORBIDDEN'))).toBe(false);
    expect(isSourceFailure(new Error('network down'))).toBe(false);
    expect(isBlocked(oxyError(451, 'CONTENT_BLOCKED'))).toBe(true);
    expect(isSourceFailure(oxyError(451, 'CONTENT_BLOCKED'))).toBe(false);
  });

  it("builds Oxy's public CDN address at a rung, without a credential", () => {
    expect(oxyFileUrl('f1', 'w640')).toBe('https://cloud.oxy.so/f1?variant=w640');
    expect(oxyFileUrl('f1')).toBe('https://cloud.oxy.so/f1');
  });
});
