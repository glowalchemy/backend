/**
 * search.js — /api/search routes
 *
 *  GET /api/search/suggest?q=…   lightweight autocomplete (products + categories + brands)
 *  GET /api/search?q=…&filters…  full search (items + pagination + facets + suggestions)
 *
 * Both delegate to the current MongoDB search provider (catalogService +
 * searchService). The frontend never sees which provider is in use.
 */

const express = require('express');
const router = express.Router();

const catalogService = require('../services/catalogService');
const cacheService = require('../services/cacheService');
const searchProvider = require('../services/searchProvider');
const { normalizeQuery } = require('../services/searchService');

// GET /api/search/suggest?q=perf
router.get('/suggest', async (req, res) => {
  try {
    const q = String(req.query?.q || '').trim();
    const limit = Math.min(10, Math.max(1, Number(req.query?.limit) || 6));
    if (!q) {
      return res.json({ products: [], categories: [], brands: [], query: '' });
    }

    const host = req.get('host') || 'local';
    const key = `suggest|${host}|${normalizeQuery(q)}|${limit}`;
    const result = await cacheService.getOrSet(key, () => searchProvider.getSuggestions({ q, req, limit }));
    res.set('Cache-Control', 'public, max-age=15, s-maxage=15');
    if (result.cached && result.value) result.value._cached = true;
    res.json(result.value);
  } catch (error) {
    console.error('Error in search suggest:', error);
    res.status(500).json({ success: false, message: 'Failed to search' });
  }
});

// GET /api/search?q=perfume&page=1&limit=24&facets=true
router.get('/', async (req, res) => {
  try {
    const q = String(req.query?.q || '').trim();
    if (!q) {
      return res.status(400).json({ success: false, message: 'q is required' });
    }
    const page = catalogService.parseIntQuery(req.query?.page) ?? 1;
    const limit = catalogService.parseIntQuery(req.query?.limit) ?? 24;
    const data = await catalogService.queryCatalog({
      req,
      mode: 'public',
      q,
      category: String(req.query?.category || '').trim() || undefined,
      subCategoryId: String(req.query?.subCategoryId || '').trim() || undefined,
      minPrice: catalogService.parseIntQuery(req.query?.minPrice),
      maxPrice: catalogService.parseIntQuery(req.query?.maxPrice),
      inStock: String(req.query?.inStock || '').toLowerCase() === 'true' ? true : undefined,
      onSale: String(req.query?.onSale || '').toLowerCase() === 'true' ? true : undefined,
      featured: String(req.query?.featured || '').toLowerCase() === 'true' ? true : undefined,
      rating: catalogService.parseIntQuery(req.query?.rating),
      sizes: catalogService.parseCsvQuery(req.query?.sizes),
      colors: catalogService.parseCsvQuery(req.query?.colors),
      brands: catalogService.parseCsvQuery(req.query?.brands),
      sort: String(req.query?.sort || '').trim() || undefined,
      page,
      limit,
      wantFacets: String(req.query?.facets || '').toLowerCase() === 'true',
    });

    const suggestions = await catalogService.suggestForQuery(q, { limit: 3 });
    res.set('Cache-Control', 'public, max-age=15, s-maxage=15');
    res.json({ ...data, suggestions });
  } catch (error) {
    console.error('Error in search:', error);
    res.status(500).json({ success: false, message: 'Failed to search' });
  }
});

module.exports = router;
