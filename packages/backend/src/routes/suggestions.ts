import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authenticateToken, optionalAuth } from '../middleware/auth.js';
import { log } from '../lib/logger.js';
import {
  createSuggestion,
  deleteOwnSuggestion,
  incrementSuggestionUsage,
  listOwnSuggestions,
  listSuggestions,
  listWelcomePool,
  searchSuggestions,
  updateOwnSuggestion,
  type SuggestionPatch,
} from '../db/suggestion-repository.js';

const router = Router();
type SearchSuggestion = Awaited<ReturnType<typeof searchSuggestions>>[number];

function routeParam(req: Request, key: string): string {
  const value = req.params[key];
  return Array.isArray(value) ? value[0] : value;
}

// ============== IN-MEMORY CACHE ==============

const cache = new Map<string, { data: SearchSuggestion[]; expiresAt: number }>();
const CACHE_MAX_SIZE = 500;
const SEARCH_CACHE_TTL = 3 * 60 * 1000; // 3 min — autocomplete results

function cacheGet(key: string): SearchSuggestion[] | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(key: string, data: SearchSuggestion[], ttl: number): void {
  // Evict oldest if full
  if (cache.size >= CACHE_MAX_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { data, expiresAt: Date.now() + ttl });
}

// Periodic cleanup every 2 min
setInterval(
  () => {
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (entry.expiresAt < now) cache.delete(key);
    }
  },
  2 * 60 * 1000,
);

/**
 * The language a suggestion list is read in: the `language` the client sends
 * (`xx-YY`, the app's locale), else `en-US`. Nothing else is consulted.
 */
const languageSchema = z.string().regex(/^[a-z]{2}-[A-Z]{2}$/);

function requestLanguage(req: Request): string {
  const parsed = languageSchema.safeParse(req.body?.language);
  return parsed.success ? parsed.data : 'en-US';
}

/**
 * POST /suggestions/list
 * List suggestions with filters.
 * Body: { language?, type?, category?, limit?, offset? }
 */
router.post('/list', optionalAuth, async (req: Request, res: Response) => {
  try {
    const { type, category, limit = 200, offset = 0 } = req.body || {};
    const language = requestLanguage(req);

    const suggestions = await listSuggestions({
      language,
      ...(type === 'welcome' || type === 'autocomplete' ? { type } : {}),
      ...(typeof category === 'string' ? { category } : {}),
      ...(req.user?.id ? { oxyUserId: req.user.id } : {}),
      offset: Number(offset) || 0,
      limit: Math.min(Number(limit) || 200, 500),
    });

    res.json({ suggestions });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error listing suggestions');
    res.status(500).json({ error: 'Failed to list suggestions' });
  }
});

/**
 * POST /suggestions/welcome
 * Get welcome card suggestions.
 * Body: { language?, count? }
 */
router.post('/welcome', optionalAuth, async (req: Request, res: Response) => {
  try {
    const { count = 4 } = req.body || {};
    const language = requestLanguage(req);

    const requestedCount = Math.min(Number(count) || 4, 20);

    // Fetch a larger pool to randomly pick from
    let pool = await listWelcomePool(language, req.user?.id, requestedCount * 5);

    // Fallback to en-US if no suggestions found for user's language
    if (pool.length === 0 && language !== 'en-US') {
      pool = await listWelcomePool('en-US', req.user?.id, requestedCount * 5);
    }

    // Shuffle the eligible, user-scoped pool without inferring order from IDs.
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    // Pick requested count from the (scored or shuffled) pool
    const suggestions = pool.slice(0, requestedCount);

    res.json({ suggestions });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error getting welcome suggestions');
    res.status(500).json({ error: 'Failed to get welcome suggestions' });
  }
});

/**
 * POST /suggestions/me
 * List current user's personal suggestions (authenticated)
 */
router.post('/me', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const suggestions = await listOwnSuggestions(req.user.id);
    res.json({ suggestions });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error listing user suggestions');
    res.status(500).json({ error: 'Failed to list your suggestions' });
  }
});

/**
 * POST /suggestions/create
 * Create a personal suggestion (authenticated)
 */
router.post('/create', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { title, text, description, type, category, triggerWords, tags, expiresAt } = req.body;

    if (!title || !text || !type) {
      return res.status(400).json({ error: 'title, text, and type are required' });
    }

    // Generate suggestionId
    const suggestionId = `user-${title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 40)}-${Date.now().toString(36).slice(-4)}`;

    const suggestion = await createSuggestion({
      suggestionId,
      title,
      text,
      description: description || '',
      type,
      category: category || 'general',
      triggerWords: triggerWords || [],
      tags: tags || [],
      scope: 'personal',
      language: requestLanguage(req),
      isBuiltIn: false,
      isAiGenerated: false,
      oxyUserId: req.user.id,
      ...(expiresAt ? { expiresAt: new Date(expiresAt) } : {}),
    });

    res.status(201).json({ suggestion });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error creating suggestion');
    res.status(500).json({ error: 'Failed to create suggestion' });
  }
});

/**
 * PATCH /suggestions/:id
 * Update own suggestion (authenticated, owner only, non-built-in)
 */
router.patch('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const allowedFields = [
      'title',
      'text',
      'description',
      'type',
      'category',
      'triggerWords',
      'tags',
      'expiresAt',
    ];

    const patch: SuggestionPatch = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        if (field === 'expiresAt') {
          patch.expiresAt = req.body[field] ? new Date(req.body[field]) : null;
        } else {
          (patch as Record<string, unknown>)[field] = req.body[field];
        }
      }
    }

    const suggestion = await updateOwnSuggestion(routeParam(req, 'id'), req.user.id, patch);
    if (!suggestion) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }
    res.json({ suggestion });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error updating suggestion');
    res.status(500).json({ error: 'Failed to update suggestion' });
  }
});

/**
 * DELETE /suggestions/:id
 * Delete own suggestion (authenticated, owner only, non-built-in)
 */
router.delete('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const deleted = await deleteOwnSuggestion(routeParam(req, 'id'), req.user.id);

    if (!deleted) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    res.json({ success: true });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error deleting suggestion');
    res.status(500).json({ error: 'Failed to delete suggestion' });
  }
});

/**
 * POST /suggestions/search
 * Real-time autocomplete search (Google-style). Debounced client-side.
 * Body: { query, language?, limit? }
 */
router.post('/search', optionalAuth, async (req: Request, res: Response) => {
  try {
    const { query, limit = 6 } = req.body || {};
    if (!query || typeof query !== 'string' || query.trim().length < 2) {
      return res.json({ suggestions: [] });
    }

    const trimmed = query.trim().toLowerCase();
    const language = requestLanguage(req);
    const limitNum = Math.min(Number(limit) || 6, 20);

    // 1. Global results — search all languages, cache by query+language (sort order depends on pref)
    const globalCacheKey = `search:${trimmed}:${language}`;
    let globalResults = cacheGet(globalCacheKey);
    if (!globalResults) {
      globalResults = await searchSuggestions({
        query: trimmed,
        scope: 'global',
        limit: limitNum * 2,
      });
      cacheSet(globalCacheKey, globalResults, SEARCH_CACHE_TTL);
    }

    // 2. Personal results — only for authenticated users, not cached
    let personalResults: SearchSuggestion[] = [];
    if (req.user?.id) {
      personalResults = await searchSuggestions({
        query: trimmed,
        scope: 'personal',
        oxyUserId: req.user.id,
        limit: limitNum,
      });
    }

    // 3. Merge: personal first, then global, dedupe, prioritize user's language
    const seen = new Set<string>();
    const candidates: SearchSuggestion[] = [];
    for (const s of [...personalResults, ...globalResults]) {
      if (!seen.has(s.suggestionId)) {
        seen.add(s.suggestionId);
        candidates.push(s);
      }
    }
    // Sort: user's preferred language first, then others
    candidates.sort((a, b) => {
      const aMatch = a.language === language ? 0 : 1;
      const bMatch = b.language === language ? 0 : 1;
      return aMatch - bMatch;
    });
    const suggestions = candidates.slice(0, limitNum);

    res.json({ suggestions });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error searching suggestions');
    res.status(500).json({ error: 'Failed to search suggestions' });
  }
});

/**
 * POST /suggestions/:id/use
 * Increment usage count (optional auth)
 */
router.post('/:id/use', optionalAuth, async (req: Request, res: Response) => {
  try {
    await incrementSuggestionUsage(routeParam(req, 'id'));
    res.json({ success: true });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error recording suggestion usage');
    res.status(500).json({ error: 'Failed to record usage' });
  }
});

export default router;
