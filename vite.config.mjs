import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDirectory = path.join(__dirname, 'data');
const dataFilePath = path.join(dataDirectory, 'app-data.json');
const regionGeometryCache = new Map();

function createDefaultAppData() {
  return {
    version: 1,
    trips: [],
    cityRatings: {},
    collapsedCountries: {},
    preferences: {
      tripSort: 'date-desc',
      visitedOverlayEnabled: false
    },
    countriesGeoJson: null
  };
}

function normalizeAppDataShape(data) {
  const defaults = createDefaultAppData();

  return {
    version: 1,
    trips: Array.isArray(data?.trips) ? data.trips : defaults.trips,
    cityRatings: isPlainObject(data?.cityRatings) ? data.cityRatings : defaults.cityRatings,
    collapsedCountries: isPlainObject(data?.collapsedCountries) ? data.collapsedCountries : defaults.collapsedCountries,
    preferences: {
      tripSort: typeof data?.preferences?.tripSort === 'string' ? data.preferences.tripSort : defaults.preferences.tripSort,
      visitedOverlayEnabled: Boolean(data?.preferences?.visitedOverlayEnabled)
    },
    countriesGeoJson: data?.countriesGeoJson && Array.isArray(data.countriesGeoJson.features)
      ? data.countriesGeoJson
      : null
  };
}

async function ensureDataFile() {
  await mkdir(dataDirectory, { recursive: true });

  try {
    const raw = await readFile(dataFilePath, 'utf8');
    return normalizeAppDataShape(JSON.parse(raw));
  } catch {
    const defaults = createDefaultAppData();
    await writeFile(dataFilePath, JSON.stringify(defaults, null, 2));
    return defaults;
  }
}

async function saveDataFile(data) {
  const normalized = normalizeAppDataShape(data);
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(dataFilePath, JSON.stringify(normalized, null, 2));
  return normalized;
}

function createDataApiPlugin() {
  const handler = async (req, res) => {
    if (req.method === 'GET') {
      const data = await ensureDataFile();
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(data, null, 2));
      return;
    }

    if (req.method === 'PUT') {
      const chunks = [];

      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', async () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          const payload = raw ? JSON.parse(raw) : createDefaultAppData();
          const saved = await saveDataFile(payload);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(saved, null, 2));
        } catch {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: 'invalid_json' }));
        }
      });

      return;
    }

    res.statusCode = 405;
    res.end();
  };

  return {
    name: 'travel-graph-data-api',
    configureServer(server) {
      server.middlewares.use('/api/app-data', handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/app-data', handler);
    }
  };
}

function createRegionGeometryApiPlugin() {
  const handler = async (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405;
      res.end();
      return;
    }

    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const region = requestUrl.searchParams.get('region')?.trim();
    const city = requestUrl.searchParams.get('city')?.trim();
    const country = requestUrl.searchParams.get('country')?.trim();
    if ((!region && !city) || !country) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'invalid_region_query' }));
      return;
    }

    try {
      const feature = await loadRegionFeature({ region, city, country });
      if (!feature?.geometry) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'region_not_found' }));
        return;
      }

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(feature));
    } catch {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'region_fetch_failed' }));
    }
  };

  return {
    name: 'travel-graph-region-geometry-api',
    configureServer(server) {
      server.middlewares.use('/api/region-geometry', handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/region-geometry', handler);
    }
  };
}

async function loadRegionFeature({ region, city, country }) {
  const primaryLabel = region || city || '';
  const cacheKey = `${normalizeLookup(primaryLabel)}::${normalizeLookup(country)}`;
  if (regionGeometryCache.has(cacheKey)) {
    return regionGeometryCache.get(cacheKey);
  }

  const queries = [
    region ? `${region}, ${country}` : null,
    city ? `${city}, ${country}` : null,
    region && city ? `${city}, ${region}, ${country}` : null
  ].filter(Boolean);

  let item = null;
  for (const lookup of queries) {
    const matches = await fetchRegionCandidates(lookup);
    item = pickBestRegionCandidate(matches, region, city, country);
    if (item) {
      break;
    }
  }

  const feature = item?.geojson ? {
    type: 'Feature',
    properties: {
      name: item.display_name || `${primaryLabel}, ${country}`,
      region: region || city || null,
      city: city || null,
      country
    },
    geometry: item.geojson
  } : null;

  regionGeometryCache.set(cacheKey, feature);
  return feature;
}

async function fetchRegionCandidates(lookup) {
  const query = new URL('https://nominatim.openstreetmap.org/search');
  query.searchParams.set('q', lookup);
  query.searchParams.set('format', 'jsonv2');
  query.searchParams.set('polygon_geojson', '1');
  query.searchParams.set('limit', '8');
  query.searchParams.set('accept-language', 'en');

  const matches = await safeFetchJson(query, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'travel-graph-app/1.0'
    }
  });

  return Array.isArray(matches) ? matches : [];
}

function pickBestRegionCandidate(matches, region, city, country) {
  const normalizedRegion = normalizeLookup(region);
  const normalizedCity = normalizeLookup(city);
  const normalizedCountry = normalizeLookup(country);

  const polygonMatches = matches.filter((item) => {
    const type = item?.geojson?.type || '';
    return type === 'Polygon' || type === 'MultiPolygon';
  });

  const rankedMatches = polygonMatches.length ? polygonMatches : matches;

  return rankedMatches.find((item) => {
    const label = normalizeLookup(item?.display_name || item?.name || '');
    const itemCountry = normalizeLookup(item?.address?.country || '');
    const isAdministrative = item?.category === 'boundary' || item?.type === 'administrative' || item?.addresstype === 'state';
    const regionMatches = normalizedRegion && label.includes(normalizedRegion);
    const cityMatches = normalizedCity && label.includes(normalizedCity);
    const countryMatches = !normalizedCountry || !itemCountry || itemCountry === normalizedCountry || label.includes(normalizedCountry);
    return isAdministrative && countryMatches && (regionMatches || cityMatches || !normalizedRegion);
  }) || rankedMatches[0] || null;
}

function normalizeLookup(value) {
  return String(value || '')
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

async function safeFetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    return null;
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json') || contentType.includes('geo+json')) {
    return await response.json();
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export default defineConfig({
  plugins: [createDataApiPlugin(), createRegionGeometryApiPlugin()]
});
