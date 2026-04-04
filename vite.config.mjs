import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDirectory = path.join(__dirname, 'data');
const dataFilePath = path.join(dataDirectory, 'app-data.json');

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

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export default defineConfig({
  plugins: [createDataApiPlugin()]
});
