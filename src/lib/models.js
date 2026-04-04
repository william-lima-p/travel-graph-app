export const DEFAULT_TRIP_SORT = 'date-desc';

const VALID_TRIP_SORTS = new Set([
  'date-desc',
  'date-asc',
  'name-asc',
  'status'
]);

export function createDefaultAppData() {
  return {
    version: 1,
    trips: [],
    cityRatings: {},
    collapsedCountries: {},
    preferences: {
      tripSort: DEFAULT_TRIP_SORT,
      visitedOverlayEnabled: false
    },
    countriesGeoJson: null
  };
}

export function normalizeAppDataShape(data) {
  const defaults = createDefaultAppData();

  return {
    version: 1,
    trips: Array.isArray(data?.trips)
      ? data.trips.map((trip) => normalizeTripRecord(trip))
      : defaults.trips,
    cityRatings: normalizeRatingsMap(data?.cityRatings),
    collapsedCountries: normalizePlainObject(data?.collapsedCountries),
    preferences: {
      tripSort: VALID_TRIP_SORTS.has(data?.preferences?.tripSort)
        ? data.preferences.tripSort
        : defaults.preferences.tripSort,
      visitedOverlayEnabled: Boolean(data?.preferences?.visitedOverlayEnabled)
    },
    countriesGeoJson: isGeoJsonFeatureCollection(data?.countriesGeoJson)
      ? data.countriesGeoJson
      : null
  };
}

export function createSerializableAppData({
  trips,
  cityRatings,
  collapsedCountries,
  tripSort,
  visitedOverlayEnabled,
  countriesGeoJson
}) {
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

export function normalizeTripRecord(trip) {
  const cities = Array.isArray(trip?.cities)
    ? trip.cities.map((city) => normalizeCity(city))
    : [];

  return {
    name: typeof trip?.name === 'string' ? trip.name : '',
    month: typeof trip?.month === 'string' && /^\d{4}-\d{2}$/.test(trip.month) ? trip.month : '',
    status: trip?.status === 'completed' ? 'completed' : 'planned',
    createdAt: Number.isFinite(trip?.createdAt) ? trip.createdAt : Date.now(),
    cities,
    distance: Number.isFinite(trip?.distance) ? trip.distance : totalDistance(cities)
  };
}

export function normalizeCity(city) {
  return {
    lat: Number(city?.lat),
    lng: Number(city?.lng),
    cityName: city?.cityName || null,
    regionName: city?.regionName || null,
    country: city?.country || null,
    countryCode: city?.countryCode ? String(city.countryCode).toLowerCase() : null,
    ratings: normalizeRatings(city?.ratings)
  };
}

export function normalizeRatingsMap(value) {
  if (!isPlainObject(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, ratings]) => [key, normalizeRatings(ratings)])
  );
}

export function normalizeRatings(ratings) {
  return {
    cuisine: normalizeRatingValue(ratings?.cuisine),
    museums: normalizeRatingValue(ratings?.museums),
    monuments: normalizeRatingValue(ratings?.monuments),
    walkable: normalizeRatingValue(ratings?.walkable),
    overall: normalizeRatingValue(ratings?.overall),
    isCity: ratings?.isCity !== false,
    customName: typeof ratings?.customName === 'string' ? ratings.customName : ''
  };
}

export function normalizeRatingValue(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  return Math.max(0, Math.min(5, Math.round(numeric)));
}

export function hasResolvedLocation(city) {
  return Boolean(city?.country && city?.countryCode && city?.cityName);
}

export function hasMeaningfulAppData(data) {
  return Boolean(
    data &&
    (
      (Array.isArray(data.trips) && data.trips.length) ||
      Object.keys(data.cityRatings || {}).length ||
      Object.keys(data.collapsedCountries || {}).length ||
      data.countriesGeoJson
    )
  );
}

function totalDistance(list) {
  let total = 0;

  for (let index = 1; index < list.length; index += 1) {
    const previous = list[index - 1];
    const current = list[index];
    total += distanceBetweenPointsKm(previous.lat, previous.lng, current.lat, current.lng);
  }

  return total;
}

function distanceBetweenPointsKm(latA, lngA, latB, lngB) {
  const earthRadiusKm = 6371;
  const dLat = ((latB - latA) * Math.PI) / 180;
  const dLon = ((lngB - lngA) * Math.PI) / 180;

  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((latA * Math.PI) / 180) *
    Math.cos((latB * Math.PI) / 180) *
    Math.sin(dLon / 2) ** 2;

  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function normalizePlainObject(value) {
  return isPlainObject(value) ? { ...value } : {};
}

function isGeoJsonFeatureCollection(value) {
  return Boolean(value && value.type === 'FeatureCollection' && Array.isArray(value.features));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
