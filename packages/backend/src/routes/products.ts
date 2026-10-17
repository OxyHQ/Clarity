/**
 * The public products surface behind `clarity.surf`'s Shopping page.
 *
 * Products are public information in the way a job posting is, so this router
 * reads no session and carries no user identity; burst protection is keyed by
 * address. It is one door onto `search/products/mercaria-catalog.ts`; the
 * credentialed `/v1/products` (an `oxy_sk` with `clarity:search`) and the
 * capability catalogue's tools are the others. All three call the same
 * functions, so there is one answer.
 */
import { Router } from 'express';

import { anonymousRateLimit } from '../middleware/anonymous-rate-limit.js';
import { optionalAuth } from '../middleware/auth.js';
import { sendError } from '../middleware/resource-auth.js';
import {
  getProduct,
  ProductCatalogError,
  productIdSchema,
  productSearchSchema,
  searchProducts,
} from '../search/products/mercaria-catalog.js';

const router = Router();
// This surface is not reviewed for supervised consumption. Presented bearers never downgrade to anonymous.
router.use(optionalAuth);
/** Its own bucket: reading the Shopping page must not rate-limit Jobs or Finance. */
router.use(anonymousRateLimit('anon:products:'));

router.get('/search', async (req, res) => {
  const parsed = productSearchSchema.safeParse({
    query: req.query.q,
    market: req.query.market,
    limit: req.query.limit,
    cursor: req.query.cursor,
  });
  if (!parsed.success) {
    sendError(
      res,
      400,
      'invalid_request',
      'q must be 1–200 characters; market a country code',
      req,
      {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    );
    return;
  }
  try {
    res.json(await searchProducts(parsed.data));
  } catch (error) {
    if (error instanceof ProductCatalogError) {
      sendError(res, error.status, error.code, error.message, req);
      return;
    }
    throw error;
  }
});

router.get('/:id', async (req, res) => {
  const id = productIdSchema.safeParse(req.params.id);
  if (!id.success) {
    sendError(res, 404, 'not_found', 'No such product', req);
    return;
  }
  try {
    res.json(await getProduct(id.data));
  } catch (error) {
    if (error instanceof ProductCatalogError) {
      sendError(res, error.status, error.code, error.message, req);
      return;
    }
    throw error;
  }
});

export default router;
