function pickBestCityName(address, displayName) {
  const directName =
    address?.city ||
    address?.town ||
    address?.village ||
    address?.municipality ||
    address?.city_district ||
    address?.district ||
    address?.suburb ||
    address?.borough ||
    address?.hamlet ||
    null;

  if (directName) {
    return directName;
  }

  return String(displayName || '')
    .split(',')
    .map((part) => part.trim())
    .find(Boolean) || null;
}

export function createLocationService({ loadWorldGeoJson, getCountryLabelFromCode }) {
  const locationCache = new Map();
  const locationRequests = new Map();

  return {
    clearCache() {
      locationCache.clear();
      locationRequests.clear();
    },

    async reverseGeocodeLocation(lat, lng) {
      const cacheKey = `${lat.toFixed(3)},${lng.toFixed(3)}`;
      if (locationCache.has(cacheKey)) {
        return locationCache.get(cacheKey);
      }

      if (locationRequests.has(cacheKey)) {
        return locationRequests.get(cacheKey);
      }

      const request = (async () => {
        const primary = await reverseGeocodeWithNominatim(lat, lng);
        const secondary = needsBetterLocationResult(primary)
          ? await reverseGeocodeWithBigDataCloud(lat, lng)
          : null;
        const countryFallback = needsCountryFallback(primary, secondary)
          ? await reverseGeocodeCountryOnly(lat, lng)
          : null;
        const polygonFallback = needsCountryFallback(primary, secondary) && !hasCountryData(countryFallback)
          ? await reverseGeocodeWithCountryPolygon(lat, lng, loadWorldGeoJson, getCountryLabelFromCode)
          : null;

        const result = mergeLocationResults(primary, secondary, countryFallback, polygonFallback);
        if (!hasAnyResolvedLocationData(result)) {
          return null;
        }

        locationCache.set(cacheKey, result);
        return result;
      })().catch(() => null).finally(() => {
        locationRequests.delete(cacheKey);
      });

      locationRequests.set(cacheKey, request);
      return request;
    }
  };
}

export function applyResolvedLocation(city, resolved) {
  let changed = false;

  if (resolved?.cityName && city.cityName !== resolved.cityName) {
    city.cityName = resolved.cityName;
    changed = true;
  }

  if (resolved?.regionName && city.regionName !== resolved.regionName) {
    city.regionName = resolved.regionName;
    changed = true;
  }

  if (resolved?.country && city.country !== resolved.country) {
    city.country = resolved.country;
    changed = true;
  }

  if (resolved?.countryCode && city.countryCode !== resolved.countryCode) {
    city.countryCode = resolved.countryCode;
    changed = true;
  }

  return changed;
}

function hasCountryData(location) {
  return Boolean(location?.country && location?.countryCode);
}

function hasAnyResolvedLocationData(location) {
  return Boolean(
    location &&
    (location.cityName || location.regionName || location.country || location.countryCode)
  );
}

function needsBetterLocationResult(result) {
  return !result || !result.cityName || !result.country || !result.countryCode;
}

function needsCountryFallback(primary, secondary) {
  const merged = mergeLocationResults(primary, secondary);
  return !merged.country || !merged.countryCode;
}

function mergeLocationResults(primary, secondary, tertiary, quaternary) {
  const fallback = {
    cityName: null,
    regionName: null,
    country: null,
    countryCode: null
  };

  const left = primary || fallback;
  const right = secondary || fallback;
  const extra = tertiary || fallback;
  const final = quaternary || fallback;

  return {
    cityName: left.cityName || right.cityName || extra.cityName || final.cityName || null,
    regionName: left.regionName || right.regionName || extra.regionName || final.regionName || null,
    country: left.country || right.country || extra.country || final.country || null,
    countryCode: left.countryCode || right.countryCode || extra.countryCode || final.countryCode || null
  };
}

async function reverseGeocodeWithNominatim(lat, lng) {
  const url = new URL('https://nominatim.openstreetmap.org/reverse');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('lat', lat);
  url.searchParams.set('lon', lng);
  url.searchParams.set('zoom', '10');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('accept-language', 'pt-BR');

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    return null;
  }

  const data = await response.json();
  return {
    cityName: pickBestCityName(data.address, data.display_name),
    regionName: data.address?.state || data.address?.region || null,
    country: data.address?.country || null,
    countryCode: data.address?.country_code || null
  };
}

async function reverseGeocodeWithBigDataCloud(lat, lng) {
  const url = new URL('https://api.bigdatacloud.net/data/reverse-geocode-client');
  url.searchParams.set('latitude', lat);
  url.searchParams.set('longitude', lng);
  url.searchParams.set('localityLanguage', 'pt');

  const response = await fetch(url);
  if (!response.ok) {
    return null;
  }

  const data = await response.json();
  return {
    cityName:
      data.city ||
      data.locality ||
      data.localityInfo?.administrative?.find((item) => item.order === 5)?.name ||
      null,
    regionName: data.principalSubdivision || null,
    country: data.countryName || null,
    countryCode: data.countryCode ? data.countryCode.toLowerCase() : null
  };
}

async function reverseGeocodeCountryOnly(lat, lng) {
  const url = new URL('https://nominatim.openstreetmap.org/reverse');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('lat', lat);
  url.searchParams.set('lon', lng);
  url.searchParams.set('zoom', '4');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('accept-language', 'pt-BR');

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    return null;
  }

  const data = await response.json();
  return {
    cityName: null,
    regionName: data.address?.state || data.address?.region || null,
    country: data.address?.country || null,
    countryCode: data.address?.country_code || null
  };
}

async function reverseGeocodeWithCountryPolygon(lat, lng, loadWorldGeoJson, getCountryLabelFromCode) {
  const geoJson = await loadWorldGeoJson();
  if (!geoJson?.features?.length) {
    return null;
  }

  const feature = geoJson.features.find((candidate) => pointInFeature(lat, lng, candidate));
  if (!feature) {
    return null;
  }

  const countryCode = getFeatureCountryCode(feature);
  const countryName =
    feature?.properties?.name ||
    feature?.properties?.ADMIN ||
    feature?.properties?.admin ||
    (countryCode ? getCountryLabelFromCode(countryCode) : null);

  return {
    cityName: null,
    regionName: null,
    country: countryName || null,
    countryCode: countryCode ? countryCode.toLowerCase() : null
  };
}

function pointInFeature(lat, lng, feature) {
  const geometry = feature?.geometry;
  if (!geometry) {
    return false;
  }

  if (geometry.type === 'Polygon') {
    return pointInPolygon([lng, lat], geometry.coordinates);
  }

  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some((polygon) => pointInPolygon([lng, lat], polygon));
  }

  return false;
}

function pointInPolygon(point, polygonRings) {
  if (!polygonRings?.length) {
    return false;
  }

  if (!pointInRing(point, polygonRings[0])) {
    return false;
  }

  for (let index = 1; index < polygonRings.length; index += 1) {
    if (pointInRing(point, polygonRings[index])) {
      return false;
    }
  }

  return true;
}

function pointInRing(point, ring) {
  const [x, y] = point;
  let inside = false;

  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const [xi, yi] = ring[index];
    const [xj, yj] = ring[previous];

    const intersects =
      ((yi > y) !== (yj > y)) &&
      (x < ((xj - xi) * (y - yi)) / ((yj - yi) || Number.EPSILON) + xi);

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

function getFeatureCountryCode(feature) {
  const code =
    feature?.properties?.['ISO3166-1-Alpha-2'] ||
    feature?.properties?.ISO_A2 ||
    feature?.properties?.iso_a2 ||
    feature?.properties?.ISO2 ||
    feature?.properties?.iso2 ||
    null;

  if (!code || code === '-99') {
    return null;
  }

  return String(code).toUpperCase();
}
