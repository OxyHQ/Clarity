import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

export interface ExtractedDocument {
  title?: string;
  description?: string;
  mainContent?: string;
  language?: string;
  canonicalUrl?: string;
  imageUrl?: string;
  faviconUrl?: string;
  documentType: 'page' | 'article' | 'news' | 'product' | 'video' | 'event' | 'recipe' | 'profile' | 'documentation' | 'other';
  structuredData: unknown[];
  evidence: Record<string, { source: string; selector?: string; extractedAt: string }>;
  noindex: boolean;
  nofollow: boolean;
}

export function extractDocument(html: string, finalUrl: string): ExtractedDocument {
  const { document } = parseHTML(html);
  const extractedAt = new Date().toISOString();
  const jsonLd = [...document.querySelectorAll('script[type="application/ld+json"]')].flatMap((element) => {
    try {
      const parsed: unknown = JSON.parse(element.textContent || 'null');
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  }).filter((value) => value !== null);
  const readable = new Readability(document).parse();
  const title = content(document, 'meta[property="og:title"]', 'content') || readable?.title || document.title || undefined;
  const description = content(document, 'meta[property="og:description"]', 'content') || content(document, 'meta[name="description"]', 'content') || readable?.excerpt || undefined;
  const canonicalUrl = absolute(content(document, 'link[rel="canonical"]', 'href'), finalUrl);
  const imageUrl = absolute(content(document, 'meta[property="og:image"]', 'content') || content(document, 'meta[name="twitter:image"]', 'content'), finalUrl);
  const faviconUrl = absolute(content(document, 'link[rel~="icon"]', 'href'), finalUrl);
  const robots = `${content(document, 'meta[name="robots"]', 'content') || ''},${content(document, 'meta[name="googlebot"]', 'content') || ''}`.toLowerCase().split(',').map((item) => item.trim());
  return {
    title,
    description,
    mainContent: readable?.textContent?.trim() || document.body?.textContent?.replace(/\s+/g, ' ').trim() || undefined,
    language: document.documentElement.getAttribute('lang') || undefined,
    canonicalUrl,
    imageUrl,
    faviconUrl,
    documentType: classify(jsonLd),
    structuredData: jsonLd,
    evidence: {
      ...(title ? { title: content(document, 'meta[property="og:title"]', 'content')
        ? { source: 'html', selector: 'meta[property="og:title"]', extractedAt }
        : { source: 'readability', extractedAt } } : {}),
      ...(description ? { description: { source: 'html', extractedAt } } : {}),
      ...(canonicalUrl ? { canonicalUrl: { source: 'html', selector: 'link[rel="canonical"]', extractedAt } } : {}),
    },
    noindex: robots.includes('noindex'),
    nofollow: robots.includes('nofollow'),
  };
}

function content(document: ReturnType<typeof parseHTML>['document'], selector: string, attribute: string): string | undefined {
  return document.querySelector(selector)?.getAttribute(attribute)?.trim() || undefined;
}

function absolute(value: string | undefined, base: string): string | undefined {
  if (!value) return undefined;
  try { return new URL(value, base).toString(); } catch { return undefined; }
}

function classify(values: unknown[]): ExtractedDocument['documentType'] {
  const types = values.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const type = (value as Record<string, unknown>)['@type'];
    return Array.isArray(type) ? type.filter((item): item is string => typeof item === 'string') : typeof type === 'string' ? [type] : [];
  }).map((type) => type.toLowerCase());
  if (types.some((type) => type.includes('newsarticle'))) return 'news';
  if (types.some((type) => type.includes('article'))) return 'article';
  if (types.some((type) => type.includes('product'))) return 'product';
  if (types.some((type) => type.includes('video'))) return 'video';
  if (types.some((type) => type.includes('event'))) return 'event';
  if (types.some((type) => type.includes('recipe'))) return 'recipe';
  if (types.some((type) => type.includes('person') || type.includes('profile'))) return 'profile';
  if (types.some((type) => type.includes('techarticle') || type.includes('api'))) return 'documentation';
  return 'page';
}
