import {
  createDefaultAppData,
  hasMeaningfulAppData,
  normalizeAppDataShape
} from './models.js';

const APP_DATA_ENDPOINT = '/api/app-data';
const LEGACY_GEOJSON_DB_NAME = 'travel-graph-assets';
const LEGACY_GEOJSON_STORE_NAME = 'assets';
const LEGACY_GEOJSON_KEY = 'countriesGeoJson';

let fileApiAvailable = null;

export async function loadInitialAppData() {
  const fileData = await loadAppData();
  const legacyData = await readLegacyBrowserData();
  const mergedData = mergeLegacyBrowserDataIntoFileData(fileData, legacyData);

  if (
    fileApiAvailable === true &&
    hasMeaningfulAppData(mergedData) &&
    shouldPersistMergedData(fileData, mergedData)
  ) {
    if (await canUseFileApi()) {
      await saveAppData(mergedData);
      return { data: mergedData, source: 'merged-legacy-ratings' };
    }

    return { data: mergedData, source: 'merged-legacy-ratings-offline' };
  }

  if (hasMeaningfulAppData(fileData)) {
    return { data: fileData, source: 'file' };
  }

  if (hasMeaningfulAppData(legacyData)) {
    if (await canUseFileApi()) {
      await saveAppData(legacyData);
      return { data: legacyData, source: 'legacy' };
    }

    return { data: legacyData, source: 'legacy-offline' };
  }

  return { data: fileData, source: 'empty' };
}

export async function loadAppData() {
  try {
    const response = await fetch(APP_DATA_ENDPOINT, {
      headers: {
        Accept: 'application/json'
      }
    });

    if (!response.ok) {
      fileApiAvailable = false;
      throw new Error(`Falha ao carregar ${APP_DATA_ENDPOINT}`);
    }

    fileApiAvailable = true;
    return normalizeAppDataShape(await response.json());
  } catch {
    const fallbackData = await loadStaticAppData();
    if (fallbackData) {
      return fallbackData;
    }

    return createDefaultAppData();
  }
}

export async function saveAppData(data) {
  if (!(await canUseFileApi())) {
    throw new Error(`Falha ao salvar ${APP_DATA_ENDPOINT}`);
  }

  const payload = normalizeAppDataShape(data);

  const response = await fetch(APP_DATA_ENDPOINT, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload, null, 2)
  });

  if (!response.ok) {
    fileApiAvailable = false;
    throw new Error(`Falha ao salvar ${APP_DATA_ENDPOINT}`);
  }

  fileApiAvailable = true;
  return normalizeAppDataShape(await response.json());
}

export function downloadAppData(data) {
  const payload = JSON.stringify(normalizeAppDataShape(data), null, 2);
  const blob = new Blob([payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const dateLabel = new Date().toISOString().slice(0, 10);

  link.href = url;
  link.download = `travel-graph-data-${dateLabel}.json`;
  link.click();

  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function readLegacyBrowserData() {
  const defaults = createDefaultAppData();

  const trips = parseJson(localStorage.getItem('trips'), []);
  const cityRatings = parseJson(localStorage.getItem('cityRatings'), {});
  const collapsedCountries = parseJson(localStorage.getItem('collapsedCountries'), {});
  const tripSort = localStorage.getItem('tripSort') || defaults.preferences.tripSort;
  const visitedOverlayEnabled = localStorage.getItem('visitedOverlay') === 'true';
  const countriesGeoJson = await loadLegacyStoredCountriesGeoJson();

  return normalizeAppDataShape({
    trips,
    cityRatings,
    collapsedCountries,
    preferences: {
      tripSort,
      visitedOverlayEnabled
    },
    countriesGeoJson
  });
}

export async function canUseFileApi() {
  if (fileApiAvailable !== null) {
    return fileApiAvailable;
  }

  try {
    const response = await fetch(APP_DATA_ENDPOINT, {
      method: 'GET',
      headers: {
        Accept: 'application/json'
      }
    });

    fileApiAvailable = response.ok;
    return fileApiAvailable;
  } catch {
    fileApiAvailable = false;
    return false;
  }
}

async function loadStaticAppData() {
  const fallbackSources = [
    '/data/app-data.json',
    './data/app-data.json',
    'data/app-data.json'
  ];

  for (const source of fallbackSources) {
    try {
      const response = await fetch(source, {
        headers: {
          Accept: 'application/json'
        }
      });

      if (!response.ok) {
        continue;
      }

      return normalizeAppDataShape(await response.json());
    } catch {
      continue;
    }
  }

  fileApiAvailable = false;
  return null;
}

function mergeLegacyBrowserDataIntoFileData(fileData, legacyData) {
  return normalizeAppDataShape({
    ...fileData,
    trips:
      Array.isArray(fileData?.trips) && fileData.trips.length
        ? fileData.trips
        : (legacyData?.trips || []),
    cityRatings: {
      ...(legacyData?.cityRatings || {}),
      ...(fileData?.cityRatings || {})
    },
    collapsedCountries: {
      ...(legacyData?.collapsedCountries || {}),
      ...(fileData?.collapsedCountries || {})
    },
    preferences: {
      ...legacyData?.preferences,
      ...fileData?.preferences
    },
    countriesGeoJson: fileData?.countriesGeoJson || legacyData?.countriesGeoJson || null
  });
}

function hasMoreRatingsThan(left, right) {
  return Object.keys(right?.cityRatings || {}).length > Object.keys(left?.cityRatings || {}).length;
}

function shouldPersistMergedData(fileData, mergedData) {
  return (
    hasMoreRatingsThan(fileData, mergedData) ||
    (
      (!Array.isArray(fileData?.trips) || !fileData.trips.length) &&
      Array.isArray(mergedData?.trips) &&
      mergedData.trips.length > 0
    )
  );
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function openLegacyGeoJsonDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LEGACY_GEOJSON_DB_NAME, 1);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(LEGACY_GEOJSON_STORE_NAME)) {
        database.createObjectStore(LEGACY_GEOJSON_STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadLegacyStoredCountriesGeoJson() {
  if (typeof indexedDB === 'undefined') {
    return null;
  }

  try {
    const database = await openLegacyGeoJsonDatabase();

    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(LEGACY_GEOJSON_STORE_NAME, 'readonly');
      const store = transaction.objectStore(LEGACY_GEOJSON_STORE_NAME);
      const request = store.get(LEGACY_GEOJSON_KEY);

      request.onsuccess = () => {
        resolve(request.result || null);
        database.close();
      };

      request.onerror = () => {
        reject(request.error);
        database.close();
      };
    });
  } catch {
    return null;
  }
}
