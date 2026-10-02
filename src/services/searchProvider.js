/**
 * searchProvider.js — thin provider boundary for search.
 *
 * The API layer and the frontend must NOT know which search backend is in use.
 * The current provider is the optimized MongoDB provider; when scale/requirements
 * justify Atlas Search, implement an AtlasSearchProvider with the same two
 * functions and swap it here without touching routes or the UI.
 *
 * Future Atlas provider would implement:
 *   searchCatalog(params)  → { items, pagination, facets, search }
 *   getSuggestions(params) → { products, categories, brands }
 * using an Atlas Search index synced from buildSearchProjection().
 */

const catalogService = require('./catalogService');
const searchService = require('./searchService');

/** Full catalog/search query (products listing incl. filters/sort/pagination/facets). */
async function searchCatalog({ req, ...params }) {
  return catalogService.queryCatalog({ req, ...params });
}

/** Lightweight autocomplete suggestions. */
async function getSuggestions({ q, req, limit }) {
  const { buildSearchFilter, rankProducts, candidateCap, normalizeQuery } = searchService;
  const mongoose = require('mongoose');
  const baseFilter = catalogService.publicBaseFilter('public');
  const { filter, tokens, full } = buildSearchFilter(q, baseFilter, { minChars: 1 });
  const docs = await mongoose.connection.db.collection('products')
    .find(filter)
    .project(catalogService.SEARCH_SUGGEST_PROJECTION)
    .sort({ createdAt: -1 })
    .limit(candidateCap())
    .toArray();
  const top = rankProducts(docs, tokens, full).slice(0, limit || 6).map((s) => s.p);
  const products = await catalogService.mapProducts(req, top);
  const suggestions = await catalogService.suggestForQuery(q, { limit: 3 });
  return { products, categories: suggestions.categories, brands: suggestions.brands, query: full };
}

module.exports = { searchCatalog, getSuggestions, providerName: 'mongo-current' };
