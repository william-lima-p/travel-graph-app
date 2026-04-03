const map = L.map('map', { editable: true }).setView([-23.55, -46.63], 4);

L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  subdomains: 'abcd',
  maxZoom: 19
}).addTo(map);

const cities = [];
const markers = [];
let polyline = null;
let selectedTripIndex = null;
let tripSort = localStorage.getItem('tripSort') || 'date-desc';
let visitedOverlayEnabled = localStorage.getItem('visitedOverlay') === 'true';
let visitedCountriesLayer = null;
let activeTab = 'trips';
const regionNamesInEnglish = typeof Intl !== 'undefined' && Intl.DisplayNames
  ? new Intl.DisplayNames(['en'], { type: 'region' })
  : null;

const trips = JSON.parse(localStorage.getItem('trips') || '[]').map(normalizeTripRecord);
const locationCache = new Map();
const locationRequests = new Map();
const cityRatings = JSON.parse(localStorage.getItem('cityRatings') || '{}');
const collapsedCountries = JSON.parse(localStorage.getItem('collapsedCountries') || '{}');
const CITY_PROXIMITY_KM = 35;

const tripNameInput = document.getElementById('tripName');
const tripMonthInput = document.getElementById('tripMonth');
const tripStatusInput = document.getElementById('tripStatus');
const tripList = document.getElementById('tripList');
const cityListEl = document.getElementById('cityList');
const cityListStatusEl = document.getElementById('cityListStatus');
const tripSortInput = document.getElementById('tripSort');
const distanceEl = document.getElementById('distance');
const tripModeEl = document.getElementById('tripMode');
const newTripBtn = document.getElementById('newTrip');
const visitedOverlayToggleBtn = document.getElementById('visitedOverlayToggle');
const visitedOverlayStatusEl = document.getElementById('visitedOverlayStatus');
const tripsTabBtn = document.getElementById('tripsTabBtn');
const citiesTabBtn = document.getElementById('citiesTabBtn');
const tripsTabEl = document.getElementById('tripsTab');
const citiesTabEl = document.getElementById('citiesTab');
const importCountriesBtn = document.getElementById('importCountriesBtn');
const countriesFileInput = document.getElementById('countriesFileInput');
const countriesFileStatusEl = document.getElementById('countriesFileStatus');

let worldGeoJsonCache = null;

const pinIcon = L.divIcon({
  html: '<div style="font-size:32px;">&#128205;</div>',
  className: '',
  iconSize: [32, 32],
  iconAnchor: [16, 32]
});
const regionNamesInPortuguese = typeof Intl !== 'undefined' && Intl.DisplayNames
  ? new Intl.DisplayNames(['pt-BR'], { type: 'region' })
  : null;

syncCountriesFileStatus('Usando busca online para identificar paises');
importCountriesBtn.onclick = () => countriesFileInput.click();
countriesFileInput.onchange = async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  syncCountriesFileStatus('Importando mapa de paises...');

  try {
    const geoJson = JSON.parse(await file.text());
    if (!geoJson?.features?.length) {
      throw new Error('Arquivo invalido');
    }

    await saveStoredCountriesGeoJson(geoJson);
    worldGeoJsonCache = geoJson;
    locationCache.clear();
    locationRequests.clear();
    syncCountriesFileStatus(`Mapa local carregado: ${file.name}`);

    if (selectedTripIndex !== null) {
      await ensureTripLocations(trips[selectedTripIndex], selectedTripIndex);
    }

    await hydrateCompletedTrips();
    renderTrips();
    renderVisitedCitiesList();
    await refreshVisitedCountriesLayer();
  } catch {
    syncCountriesFileStatus('Falha ao importar o arquivo de paises');
  } finally {
    countriesFileInput.value = '';
  }
};

document.getElementById('saveTrip').onclick = async () => {
  const name = tripNameInput.value.trim();
  if (!name) return;

  await Promise.all(cities.map((city) => ensureCityDetails(city)));

  const snapshot = cities.map((city) => ({ ...city }));
  const distance = totalDistance(snapshot);
  const existingTrip = selectedTripIndex !== null ? trips[selectedTripIndex] : null;
  const tripRecord = normalizeTripRecord({
    ...existingTrip,
    name,
    month: tripMonthInput.value,
    status: tripStatusInput.value,
    cities: snapshot,
    distance
  });

  if (selectedTripIndex !== null) {
    trips[selectedTripIndex] = tripRecord;
  } else {
    trips.push(tripRecord);
  }

  persistTrips();
  startNewTrip();
  renderTrips();
  renderVisitedCitiesList();
  void refreshVisitedCountriesLayer();
};

newTripBtn.onclick = () => {
  startNewTrip();
  renderTrips();
};

tripSortInput.value = tripSort;
tripSortInput.onchange = () => {
  tripSort = tripSortInput.value;
  localStorage.setItem('tripSort', tripSort);
  renderTrips();
};

syncVisitedOverlayButton();
visitedOverlayToggleBtn.onclick = async () => {
  visitedOverlayEnabled = !visitedOverlayEnabled;
  localStorage.setItem('visitedOverlay', String(visitedOverlayEnabled));
  syncVisitedOverlayButton();
  await refreshVisitedCountriesLayer();
};

tripsTabBtn.onclick = () => setActiveTab('trips');
citiesTabBtn.onclick = () => setActiveTab('cities');

document.getElementById('clearGraph').onclick = () => {
  clearCurrentRoute();
};

function loadTrip(index) {
  const trip = trips[index];

  selectedTripIndex = index;
  tripNameInput.value = trip.name;
  tripMonthInput.value = trip.month;
  tripStatusInput.value = trip.status;

  cities.length = 0;
  trip.cities.forEach((city) => cities.push(normalizeCity(city)));

  redrawMarkers();
  redraw();
  updateTripMode();
  zoomToCities(cities);
  renderTrips();
  renderVisitedCitiesList();
  void ensureTripLocations(trip, index);
}

function renderTrips() {
  tripList.innerHTML = '';

  getSortedTrips().forEach(({ trip, index }) => {
    const li = document.createElement('li');
    const flagMarkup = getFlagMarkup(getTripCountryCodes(trip));
    const dateLabel = formatTripMonth(trip.month);
    const statusLabel = trip.status === 'completed' ? 'Concluído' : 'Planejado';

    li.innerHTML = `
      <div class="trip-card ${index === selectedTripIndex ? 'trip-active' : ''}">
        <div class="trip-card-header">
          <div>
            <strong>${escapeHtml(trip.name)}</strong><br>
            <small class="trip-submeta">
              <span>${dateLabel}</span>
              <span class="status-badge status-${trip.status}">${statusLabel}</span>
            </small>
            <br>
            <small class="trip-meta">
              <span>${(trip.distance || 0).toFixed(1)} km</span>
              ${flagMarkup}
            </small>
          </div>
          <button class="btn danger deleteBtn" type="button" aria-label="Excluir viagem">&#128465;</button>
        </div>
      </div>
    `;

    li.onclick = () => loadTrip(index);

    li.querySelector('.deleteBtn').onclick = (event) => {
      event.stopPropagation();

      trips.splice(index, 1);

      if (selectedTripIndex === index) {
        startNewTrip();
      }
      else if (selectedTripIndex > index) selectedTripIndex--;

      persistTrips();
      updateTripMode();
      renderTrips();
      renderVisitedCitiesList();
      void refreshVisitedCountriesLayer();
    };

    tripList.appendChild(li);
  });
}

function redraw() {
  if (polyline) {
    map.removeLayer(polyline);
    polyline = null;
  }

  if (cities.length > 1) {
    polyline = L.polyline(cities.map((city) => [city.lat, city.lng]), {
      color: '#2563eb',
      weight: 5,
      dashArray: '6,8'
    }).addTo(map);

    polyline.enableEdit();
    polyline.on('editable:vertex:dragend editable:vertex:new', syncPolyline);
  }

  updateDistanceDisplay();
}

function redrawMarkers() {
  markers.forEach((marker) => map.removeLayer(marker));
  markers.length = 0;

  cities.forEach((city) => {
    const marker = L.marker([city.lat, city.lng], {
      draggable: true,
      icon: pinIcon
    }).addTo(map);

    updateMarkerTooltip(marker, city);

    marker.on('dragend', async (event) => {
      const pos = event.target.getLatLng();
      city.lat = pos.lat;
      city.lng = pos.lng;
      redraw();
      await ensureCityDetails(city);
      redrawMarkers();
      redraw();
      syncSelectedTripFromCities();
    });

    marker.on('contextmenu', () => {
      const i = markers.indexOf(marker);
      markers.splice(i, 1);
      cities.splice(i, 1);

      map.removeLayer(marker);
      redraw();
      syncSelectedTripFromCities();
      renderTrips();
    });

    markers.push(marker);
  });
}

async function syncPolyline() {
  const latlngs = polyline.getLatLngs();
  const previousCities = cities.map((city) => ({ ...city }));

  cities.length = 0;
  latlngs.forEach((latlng, index) => {
    const previous = previousCities[index];
    if (previous) {
      previous.lat = latlng.lat;
      previous.lng = latlng.lng;
      cities.push(previous);
      return;
    }

    cities.push(normalizeCity({ lat: latlng.lat, lng: latlng.lng }));
  });

  redrawMarkers();
  redraw();
  await Promise.all(cities.map((city) => ensureCityDetails(city)));
  syncSelectedTripFromCities();
}

map.on('click', async (event) => {
  const city = normalizeCity({ lat: event.latlng.lat, lng: event.latlng.lng });
  cities.push(city);
  redrawMarkers();
  redraw();
  await ensureCityDetails(city);
  redrawMarkers();
  redraw();
  syncSelectedTripFromCities();
});

function normalizeCity(city) {
  return {
    lat: city.lat,
    lng: city.lng,
    cityName: city.cityName || null,
    regionName: city.regionName || null,
    country: city.country || null,
    countryCode: city.countryCode ? city.countryCode.toLowerCase() : null,
    ratings: normalizeRatings(city.ratings)
  };
}

function clearLocationData(city) {
  city.cityName = null;
  city.regionName = null;
  city.country = null;
  city.countryCode = null;
}

async function ensureTripLocations(trip, index) {
  if (!trip?.cities?.length) return;
  if (trip.cities.every(hasResolvedLocation)) return;

  let changed = false;
  const previousDistance = trip.distance || 0;

  await Promise.all(
    trip.cities.map(async (city) => {
      const normalized = normalizeCity(city);
      const hasData = hasResolvedLocation(normalized);

      if (!hasData) {
        const resolved = await reverseGeocodeLocation(normalized.lat, normalized.lng);
        if (resolved) {
          changed = applyResolvedLocation(normalized, resolved) || changed;
        }
      }

      Object.assign(city, normalized);
    })
  );

  trip.distance = totalDistance(trip.cities);
  const distanceChanged = Math.abs(trip.distance - previousDistance) > 0.001;

  if (changed || distanceChanged) {
    persistTrips();
  }

  if (selectedTripIndex === index) {
    syncCitiesFromSelectedTrip();
    redrawMarkers();
    redraw();
  }

  if (changed || distanceChanged) {
    renderTrips();
    renderVisitedCitiesList();
    void refreshVisitedCountriesLayer();
  }
}

function startNewTrip() {
  selectedTripIndex = null;
  tripNameInput.value = '';
  tripMonthInput.value = getCurrentMonthValue();
  tripStatusInput.value = 'planned';
  clearCurrentRoute();
  updateTripMode();
}

function clearCurrentRoute() {
  cities.length = 0;
  markers.forEach((marker) => map.removeLayer(marker));
  markers.length = 0;

  if (polyline) {
    map.removeLayer(polyline);
    polyline = null;
  }

  updateDistanceDisplay();
}

function updateTripMode() {
  if (selectedTripIndex === null) {
    tripModeEl.textContent = 'Criando uma nova viagem';
    return;
  }

  const trip = trips[selectedTripIndex];
  tripModeEl.textContent = `Editando: ${trip?.name || 'viagem atual'}`;
}

async function ensureCityDetails(city) {
  if (hasResolvedLocation(city)) return city;

  const resolved = await reverseGeocodeLocation(city.lat, city.lng);
  if (!resolved) return city;

  const changed = applyResolvedLocation(city, resolved);
  if (changed) {
    if (selectedTripIndex !== null) {
      syncSelectedTripFromCities();
    }
    renderTrips();
    renderVisitedCitiesList();
    updateDistanceDisplay();
    void refreshVisitedCountriesLayer();
  }
  return city;
}

function normalizeTripRecord(trip) {
  return {
    name: trip.name || '',
    month: typeof trip.month === 'string' && /^\d{4}-\d{2}$/.test(trip.month) ? trip.month : '',
    status: trip.status === 'completed' ? 'completed' : 'planned',
    createdAt: Number.isFinite(trip.createdAt) ? trip.createdAt : Date.now(),
    cities: (trip.cities || []).map((city) => normalizeCity(city)),
    distance: Number.isFinite(trip.distance) ? trip.distance : totalDistance(trip.cities || [])
  };
}

function getSortedTrips() {
  const sorted = trips.map((trip, index) => ({ trip, index }));

  sorted.sort((a, b) => {
    if (tripSort === 'name-asc') {
      return a.trip.name.localeCompare(b.trip.name, 'pt-BR');
    }

    if (tripSort === 'status') {
      const statusOrder = { planned: 0, completed: 1 };
      const statusDiff = statusOrder[a.trip.status] - statusOrder[b.trip.status];
      if (statusDiff !== 0) return statusDiff;
      return compareMonthDesc(a.trip.month, b.trip.month);
    }

    if (tripSort === 'date-asc') {
      return compareMonthAsc(a.trip.month, b.trip.month);
    }

    return compareMonthDesc(a.trip.month, b.trip.month);
  });

  return sorted;
}

function compareMonthAsc(a, b) {
  const left = a || '9999-99';
  const right = b || '9999-99';
  if (left !== right) return left.localeCompare(right);
  return 0;
}

function compareMonthDesc(a, b) {
  const left = a || '0000-00';
  const right = b || '0000-00';
  if (left !== right) return right.localeCompare(left);
  return 0;
}

function formatTripMonth(monthValue) {
  if (!monthValue) return 'Sem data';

  const [year, month] = monthValue.split('-').map(Number);
  if (!year || !month) return 'Sem data';

  return new Intl.DateTimeFormat('pt-BR', {
    month: 'short',
    year: 'numeric'
  }).format(new Date(year, month - 1, 1));
}

function getCurrentMonthValue() {
  return new Date().toISOString().slice(0, 7);
}

async function reverseGeocodeCountry(lat, lng) {
  return reverseGeocodeLocation(lat, lng);
}

async function reverseGeocodeLocation(lat, lng) {
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
      ? await reverseGeocodeWithCountryPolygon(lat, lng)
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

function needsBetterCityResult(result) {
  return !result || !result.cityName;
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

async function reverseGeocodeWithCountryPolygon(lat, lng) {
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

function hasCountryData(location) {
  return Boolean(location?.country && location?.countryCode);
}

function pointInFeature(lat, lng, feature) {
  const geometry = feature?.geometry;
  if (!geometry) return false;

  if (geometry.type === 'Polygon') {
    return pointInPolygon([lng, lat], geometry.coordinates);
  }

  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some((polygon) => pointInPolygon([lng, lat], polygon));
  }

  return false;
}

function pointInPolygon(point, polygonRings) {
  if (!polygonRings?.length) return false;
  if (!pointInRing(point, polygonRings[0])) return false;

  for (let index = 1; index < polygonRings.length; index++) {
    if (pointInRing(point, polygonRings[index])) {
      return false;
    }
  }

  return true;
}

function pointInRing(point, ring) {
  const [x, y] = point;
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];

    const intersects =
      ((yi > y) !== (yj > y)) &&
      (x < ((xj - xi) * (y - yi)) / ((yj - yi) || Number.EPSILON) + xi);

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

function hasAnyResolvedLocationData(location) {
  return Boolean(
    location &&
    (location.cityName || location.regionName || location.country || location.countryCode)
  );
}

function applyResolvedLocation(city, resolved) {
  let changed = false;

  if (resolved.cityName && city.cityName !== resolved.cityName) {
    city.cityName = resolved.cityName;
    changed = true;
  }

  if (resolved.regionName && city.regionName !== resolved.regionName) {
    city.regionName = resolved.regionName;
    changed = true;
  }

  if (resolved.country && city.country !== resolved.country) {
    city.country = resolved.country;
    changed = true;
  }

  if (resolved.countryCode && city.countryCode !== resolved.countryCode) {
    city.countryCode = resolved.countryCode;
    changed = true;
  }

  return changed;
}

function updateDistanceDisplay() {
  const distance = totalDistance(cities).toFixed(2);
  const flags = getFlagMarkup(getTripCountryCodes({ cities }));

  distanceEl.innerHTML = `
    <span>Distância total: ${distance} km</span>
    ${flags}
  `;
}

function getTripCountryCodes(trip) {
  const codes = [];
  const seen = new Set();

  (trip.cities || []).forEach((city) => {
    const code = city.countryCode?.toLowerCase();
    if (!code || seen.has(code)) return;
    seen.add(code);
    codes.push(code);
  });

  return codes;
}

function getFlagMarkup(countryCodes) {
  if (!countryCodes.length) {
    return '<span class="flag-list empty">Sem bandeiras</span>';
  }

  const icons = countryCodes.map((code) => {
    const upperCode = code.toUpperCase();
    const countryLabel = getCountryLabelFromCode(upperCode);
    const primarySrc = getWikimediaFlagUrl(upperCode);
    const fallbackSrc = `https://flagcdn.com/24x18/${code}.png`;
    const fallbackSrcSet = `https://flagcdn.com/48x36/${code}.png 2x`;
    return `
      <img
        class="flag-icon"
        src="${primarySrc}"
        alt="Bandeira ${countryLabel}"
        title="${countryLabel}"
        loading="lazy"
        referrerpolicy="no-referrer"
        onerror="this.onerror=null;this.src='${fallbackSrc}';this.srcset='${fallbackSrcSet}';"
      />
    `;
  }).join('');

  return `<span class="flag-list">${icons}</span>`;
}

function updateMarkerTooltip(marker, city) {
  const locationLabel = city.cityName || city.country || 'Local da rota';
  const detail = city.cityName && city.country ? `, ${city.country}` : '';
  const label = `${locationLabel}${detail}`;
  marker.bindTooltip(label, { direction: 'top' });
}

function syncSelectedTripFromCities() {
  if (selectedTripIndex === null) return;

  const trip = trips[selectedTripIndex];
  if (!trip) return;

  trip.cities = cities.map((city) => ({ ...city }));
  trip.distance = totalDistance(cities);
  trip.month = tripMonthInput.value;
  trip.status = tripStatusInput.value;
  persistTrips();
  renderTrips();
  renderVisitedCitiesList();
  void refreshVisitedCountriesLayer();
}

function syncCitiesFromSelectedTrip() {
  if (selectedTripIndex === null) return;

  const trip = trips[selectedTripIndex];
  if (!trip) return;

  cities.length = 0;
  trip.cities.forEach((city) => cities.push(normalizeCity(city)));
}

function persistTrips() {
  localStorage.setItem('trips', JSON.stringify(trips));
}

async function refreshVisitedCountriesLayer() {
  if (!visitedOverlayEnabled) {
    if (visitedCountriesLayer) {
      map.removeLayer(visitedCountriesLayer);
      visitedCountriesLayer = null;
    }
    setVisitedOverlayStatus('Camada desligada');
    return;
  }

  const visitedCodes = getVisitedCountryCodes();
  const visitedNames = getVisitedCountryNames();
  if (!visitedCodes.size) {
    if (visitedCountriesLayer) {
      map.removeLayer(visitedCountriesLayer);
      visitedCountriesLayer = null;
    }
    setVisitedOverlayStatus('Nenhum país identificado nas viagens ainda');
    return;
  }

  setVisitedOverlayStatus(`Carregando ${visitedCodes.size} país(es)...`);
  const geoJson = await loadWorldGeoJson();
  if (!geoJson) {
    setVisitedOverlayStatus('Não foi possível carregar os contornos dos países');
    return;
  }

  if (visitedCountriesLayer) {
    map.removeLayer(visitedCountriesLayer);
  }

  const matchedCountries = new Set();
  visitedCountriesLayer = L.geoJSON(geoJson, {
    filter: (feature) => {
      const code = getFeatureCountryCode(feature);
      const name = getFeatureCountryName(feature);
      const matches = (code ? visitedCodes.has(code) : false) || (name ? visitedNames.has(name) : false);
      if (matches) {
        matchedCountries.add(code || name);
      }
      return matches;
    },
    style: {
      color: '#0f766e',
      weight: 2,
      fillColor: '#14b8a6',
      fillOpacity: 0.35
    },
    interactive: false
  }).addTo(map);

  if (!matchedCountries.size) {
    setVisitedOverlayStatus(`Nenhum polígono encontrado para ${visitedCodes.size} país(es)`);
    return;
  }

  setVisitedOverlayStatus(`${matchedCountries.size} país(es) destacados no mapa`);
}

function getVisitedCountryCodes() {
  const codes = new Set();

  trips.forEach((trip) => {
    getTripCountryCodes(trip).forEach((code) => codes.add(normalizeOverlayCountryCode(code)));
  });

  return codes;
}

function getVisitedCountryNames() {
  const names = new Set();

  trips.forEach((trip) => {
    (trip.cities || []).forEach((city) => {
      const canonicalName = getCanonicalCountryName(city);
      if (!canonicalName) return;
      names.add(canonicalName);
    });
  });

  return names;
}

function getFeatureCountryCode(feature) {
  const code =
    feature?.properties?.['ISO3166-1-Alpha-2'] ||
    feature?.properties?.ISO_A2 ||
    feature?.properties?.iso_a2 ||
    feature?.properties?.ISO2 ||
    feature?.properties?.iso2 ||
    null;

  if (!code || code === '-99') return null;
  return normalizeOverlayCountryCode(code);
}

function getFeatureCountryName(feature) {
  return normalizeCountryName(
    feature?.properties?.name ||
    feature?.properties?.ADMIN ||
    feature?.properties?.admin ||
    ''
  );
}

function normalizeOverlayCountryCode(code) {
  const normalized = String(code).toUpperCase();

  const aliases = {
    GF: 'FR',
    GP: 'FR',
    MQ: 'FR',
    RE: 'FR',
    YT: 'FR',
    NC: 'FR',
    PF: 'FR',
    BL: 'FR',
    MF: 'FR',
    PM: 'FR',
    WF: 'FR',
    TF: 'FR'
  };

  return aliases[normalized] || normalized;
}

function normalizeCountryName(name) {
  return String(name || '')
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .replaceAll(/[^a-zA-Z\s]/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function getCanonicalCountryName(city) {
  const code = city.countryCode ? normalizeOverlayCountryCode(city.countryCode) : null;

  if (code && regionNamesInEnglish) {
    const englishName = regionNamesInEnglish.of(code);
    if (englishName) {
      return normalizeCountryName(englishName);
    }
  }

  return city.country ? normalizeCountryName(city.country) : null;
}

function getCountryLabelFromCode(code) {
  return regionNamesInPortuguese?.of(code) || regionNamesInEnglish?.of(code) || code;
}

function getWikimediaFlagUrl(code) {
  const fileName = getWikimediaFlagFileName(code);
  return `https://commons.wikimedia.org/wiki/Special:Redirect/file/${encodeURIComponent(fileName)}?width=24`;
}

function getWikimediaFlagFileName(code) {
  const fileNames = {
    BR: 'Flag of Brazil.svg',
    FR: 'Flag of France.svg',
    US: 'Flag of the United States.svg',
    GB: 'Flag of the United Kingdom.svg',
    DE: 'Flag of Germany.svg',
    IT: 'Flag of Italy.svg',
    ES: 'Flag of Spain.svg',
    PT: 'Flag of Portugal.svg',
    NL: 'Flag of the Netherlands.svg',
    BE: 'Flag of Belgium.svg',
    AR: 'Flag of Argentina.svg',
    CL: 'Flag of Chile.svg',
    JP: 'Flag of Japan.svg',
    CN: "Flag of the People's Republic of China.svg",
    KR: 'Flag of South Korea.svg',
    KP: 'Flag of North Korea.svg',
    CZ: 'Flag of the Czech Republic.svg',
    DO: 'Flag of the Dominican Republic.svg',
    IE: 'Flag of Ireland.svg',
    RU: 'Flag of Russia.svg',
    CH: 'Flag of Switzerland.svg',
    ZA: 'Flag of South Africa.svg',
    NZ: 'Flag of New Zealand.svg',
    AE: 'Flag of the United Arab Emirates.svg'
  };

  if (fileNames[code]) {
    return fileNames[code];
  }

  const englishName = regionNamesInEnglish?.of(code);
  if (!englishName) {
    return `Flag of ${code}.svg`;
  }

  return `Flag of ${englishName}.svg`;
}

async function loadWorldGeoJson() {
  if (worldGeoJsonCache) {
    return worldGeoJsonCache;
  }

  const storedGeoJson = await loadStoredCountriesGeoJson();
  if (storedGeoJson) {
    worldGeoJsonCache = storedGeoJson;
    syncCountriesFileStatus('Mapa local de paises carregado do navegador');
    return storedGeoJson;
  }

  const localSources = [
    './countries.geojson',
    '/countries.geojson'
  ];

  for (const source of localSources) {
    try {
      const response = await fetch(source);
      if (!response.ok) continue;
      const geoJson = await response.json();
      if (!geoJson?.features?.length) continue;
      worldGeoJsonCache = geoJson;
      syncCountriesFileStatus('Mapa local countries.geojson encontrado no projeto');
      return geoJson;
    } catch {
      continue;
    }
  }

  const sources = [
    'https://datahub.io/core/geo-boundaries-world-110m/r/countries.geojson',
    'https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson',
    'https://cdn.jsdelivr.net/gh/datasets/geo-countries@master/data/countries.geojson'
  ];

  for (const source of sources) {
    try {
      const response = await fetch(source);
      if (!response.ok) continue;
      const geoJson = await response.json();
      if (!geoJson?.features?.length) continue;
      worldGeoJsonCache = geoJson;
      return geoJson;
    } catch {
      continue;
    }
  }

  return null;
}

function syncCountriesFileStatus(message) {
  countriesFileStatusEl.textContent = message;
}

function openGeoJsonDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('travel-graph-assets', 1);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('assets')) {
        database.createObjectStore('assets');
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadStoredCountriesGeoJson() {
  if (typeof indexedDB === 'undefined') return null;

  try {
    const database = await openGeoJsonDatabase();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction('assets', 'readonly');
      const store = transaction.objectStore('assets');
      const request = store.get('countriesGeoJson');

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

async function saveStoredCountriesGeoJson(geoJson) {
  if (typeof indexedDB === 'undefined') return;

  const database = await openGeoJsonDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction('assets', 'readwrite');
    const store = transaction.objectStore('assets');
    const request = store.put(geoJson, 'countriesGeoJson');

    request.onsuccess = () => {
      resolve();
      database.close();
    };
    request.onerror = () => {
      reject(request.error);
      database.close();
    };
  });
}

function setVisitedOverlayStatus(message) {
  visitedOverlayStatusEl.textContent = message;
  syncVisitedOverlayButton();
}

function renderVisitedCitiesList() {
  const visitedCities = buildVisitedCityGroups();

  if (!visitedCities.length) {
    cityListStatusEl.textContent = 'Use viagens concluídas para montar a lista';
    cityListEl.innerHTML = '<div class="city-empty">Nenhuma cidade concluída identificada ainda. Se as viagens já estão concluídas, abra uma delas para enriquecer os pontos com localização.</div>';
    return;
  }

  cityListStatusEl.textContent = `${visitedCities.length} cidade(s) visitada(s)`;
  cityListEl.innerHTML = '';

  const countries = groupVisitedCitiesByCountry(visitedCities);

  countries.forEach((countryGroup) => {
    const wrapper = document.createElement('section');
    wrapper.className = 'country-group';
    const isCollapsed = collapsedCountries[countryGroup.key] !== false;

    wrapper.innerHTML = `
      <button class="country-toggle" type="button">
        <span class="country-toggle-main">
          ${countryGroup.flagMarkup}
          <span class="country-toggle-label">${escapeHtml(countryGroup.label)}</span>
          <span class="country-toggle-count">${countryGroup.cities.length} cidade(s)</span>
        </span>
        <span class="country-toggle-chevron">${isCollapsed ? '▸' : '▾'}</span>
      </button>
      <div class="country-cities ${isCollapsed ? '' : 'open'}"></div>
    `;

    wrapper.querySelector('.country-toggle').onclick = () => {
      collapsedCountries[countryGroup.key] = !isCollapsed;
      persistCollapsedCountries();
      renderVisitedCitiesList();
    };

    const countryCitiesEl = wrapper.querySelector('.country-cities');

    countryGroup.cities.forEach((visitedCity) => {
      const card = document.createElement('article');
      card.className = 'city-card';
      const flagMarkup = visitedCity.countryCode ? getSingleFlagMarkup(visitedCity.countryCode) : '';
      const ratings = getCityRatings(visitedCity.id);

      card.innerHTML = `
        <div class="city-card-header">
          <div class="city-title">
            <span class="city-badge">&#128205;</span>
            <div class="city-name-block">
              <span class="city-name">${escapeHtml(getDisplayVisitedCityName(visitedCity))}</span>
              <small class="city-country">
                ${flagMarkup}
                <span>${escapeHtml(visitedCity.countryLabel)}</span>
              </small>
            </div>
          </div>
          <div class="city-card-actions">
            <button class="city-toggle-btn ${ratings.isCity !== false ? 'active' : ''}" type="button" aria-label="Alternar tipo de local" title="${ratings.isCity !== false ? 'Cidade visitável com categorias' : 'Local com nota geral'}">&#127961;</button>
            <button class="icon-btn zoom-city-btn" type="button" aria-label="Centralizar cidade" title="Ver no mapa">&#128269;</button>
            <button class="icon-btn edit-city-btn" type="button" aria-label="Editar cidade" title="Editar cidade">&#9998;</button>
          </div>
        </div>
        <div class="city-ratings">
          ${ratings.isCity !== false
            ? [
              renderRatingRow('cuisine', 'Culinária', ratings.cuisine),
              renderRatingRow('museums', 'Museus', ratings.museums),
              renderRatingRow('monuments', 'Monumentos', ratings.monuments),
              renderRatingRow('walkable', 'Andável', ratings.walkable)
            ].join('')
            : renderRatingRow('overall', 'Nota geral', ratings.overall)}
        </div>
        <div class="city-rename">
          <input class="rename-city-input" type="text" value="${escapeHtml(getDisplayVisitedCityName(visitedCity))}" placeholder="Renomear cidade" />
          <button class="icon-btn save-city-name-btn" type="button" aria-label="Salvar nome" title="Salvar nome">&#10003;</button>
          <button class="icon-btn cancel-city-name-btn" type="button" aria-label="Cancelar edição" title="Cancelar edição">&#8630;</button>
        </div>
      `;

      card.querySelector('.zoom-city-btn').onclick = () => {
        map.setView([visitedCity.lat, visitedCity.lng], 10, { animate: true });
      };

      card.querySelector('.city-toggle-btn').onclick = () => {
        const nextRatings = { ...getCityRatings(visitedCity.id) };
        nextRatings.isCity = nextRatings.isCity === false;
        cityRatings[visitedCity.id] = normalizeRatings(nextRatings);
        persistCityRatings();
        renderVisitedCitiesList();
      };

      card.querySelector('.edit-city-btn').onclick = () => {
        const renameBox = card.querySelector('.city-rename');
        renameBox.classList.add('open');
        card.querySelector('.rename-city-input').focus();
      };

      card.querySelectorAll('.star-btn').forEach((button) => {
        button.onclick = () => {
          const category = button.dataset.category;
          const value = Number(button.dataset.value);
          const nextRatings = { ...getCityRatings(visitedCity.id) };
          nextRatings[category] = nextRatings[category] === value ? 0 : value;
          cityRatings[visitedCity.id] = normalizeRatings(nextRatings);
          persistCityRatings();
          renderVisitedCitiesList();
        };
      });

      card.querySelector('.save-city-name-btn').onclick = () => {
        const input = card.querySelector('.rename-city-input');
        const customName = input.value.trim();
        const nextRatings = { ...getCityRatings(visitedCity.id) };
        nextRatings.customName = customName;
        cityRatings[visitedCity.id] = normalizeRatings(nextRatings);
        persistCityRatings();
        renderVisitedCitiesList();
      };

      card.querySelector('.cancel-city-name-btn').onclick = () => {
        card.querySelector('.city-rename').classList.remove('open');
      };

      countryCitiesEl.appendChild(card);
    });

    cityListEl.appendChild(wrapper);
  });
}

function groupVisitedCitiesByCountry(visitedCities) {
  const groups = new Map();

  visitedCities.forEach((city) => {
    const countryLabel = getCountryDisplayLabel(city);
    const key = city.countryCode || normalizeCountryName(countryLabel) || 'desconhecido';
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label: countryLabel,
        flagMarkup: city.countryCode ? getSingleFlagMarkup(city.countryCode) : '',
        cities: []
      });
    }

    groups.get(key).cities.push(city);
  });

  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
}

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

  const firstDisplayChunk = String(displayName || '')
    .split(',')
    .map((part) => part.trim())
    .find(Boolean);

  return firstDisplayChunk || null;
}

function buildVisitedCityGroups() {
  const groups = [];

  trips
    .filter((trip) => trip.status === 'completed')
    .forEach((trip) => {
      trip.cities.forEach((city, index) => {
        if (!Number.isFinite(city.lat) || !Number.isFinite(city.lng)) return;

        const match = findMatchingVisitedCityGroup(groups, city);
        if (match) {
          match.points.push(city);
          match.tripNames.add(trip.name);
          match.count += 1;
          upgradeVisitedCityGroupLocation(match, city);
          return;
        }

        groups.push({
          id: createVisitedCityId(city),
          cityName: getDisplayCityName(city, index),
          countryCode: city.countryCode || null,
          countryLabel: getCountryDisplayLabel(city),
          lat: city.lat,
          lng: city.lng,
          points: [city],
          tripNames: new Set([trip.name]),
          count: 1
        });
      });
    });

  groups.sort((a, b) => a.cityName.localeCompare(b.cityName, 'pt-BR'));
  return groups;
}

function findMatchingVisitedCityGroup(groups, city) {
  const cityName = normalizeCountryName(city.cityName || '');
  const countryCode = city.countryCode?.toLowerCase() || '';

  return groups.find((group) => {
    const sameCountry = !countryCode || !group.countryCode || group.countryCode?.toLowerCase() === countryCode;
    if (!sameCountry) return false;

    const groupName = normalizeCountryName(group.cityName || '');
    const distance = distanceBetweenPointsKm(group.lat, group.lng, city.lat, city.lng);

    if (groupName && cityName && groupName === cityName && distance <= CITY_PROXIMITY_KM * 2) {
      return true;
    }

    return distance <= CITY_PROXIMITY_KM;
  }) || null;
}

function upgradeVisitedCityGroupLocation(group, city) {
  if (!group.countryCode && city.countryCode) {
    group.countryCode = city.countryCode;
  }

  const nextCountryLabel = getCountryDisplayLabel(city);
  const hasMissingLabel =
    !group.countryLabel ||
    group.countryLabel === 'Sem pais identificado';

  if (hasMissingLabel && nextCountryLabel && nextCountryLabel !== 'Sem pais identificado') {
    group.countryLabel = nextCountryLabel;
  }
}

function createVisitedCityId(city) {
  const countryCode = normalizeOverlayCountryCode(city.countryCode || 'xx').toLowerCase();
  const normalizedCityName = normalizeCountryName(city.cityName || '');

  if (normalizedCityName) {
    return `${countryCode}:${normalizedCityName}:${city.lat.toFixed(1)}:${city.lng.toFixed(1)}`;
  }

  return `${countryCode}:coords:${city.lat.toFixed(2)}:${city.lng.toFixed(2)}`;
}

function renderRatingRow(category, label, currentValue) {
  const stars = [1, 2, 3, 4, 5].map((value) => `
    <button
      class="star-btn ${value <= currentValue ? 'active' : ''}"
      type="button"
      data-category="${category}"
      data-value="${value}"
      aria-label="${label}: ${value} estrela(s)"
    >
      ★
    </button>
  `).join('');

  return `
    <div class="rating-row">
      <span class="rating-label">${label}</span>
      <div class="star-group">${stars}</div>
    </div>
  `;
}

function getSingleFlagMarkup(countryCode) {
  const code = countryCode.toLowerCase();
  const upperCode = code.toUpperCase();
  const countryLabel = getCountryLabelFromCode(upperCode);
  const primarySrc = getWikimediaFlagUrl(upperCode);
  const fallbackSrc = `https://flagcdn.com/24x18/${code}.png`;
  const fallbackSrcSet = `https://flagcdn.com/48x36/${code}.png 2x`;

  return `
    <img
      class="flag-icon tiny"
      src="${primarySrc}"
      alt="Bandeira ${countryLabel}"
      title="${countryLabel}"
      loading="lazy"
      referrerpolicy="no-referrer"
      onerror="this.onerror=null;this.src='${fallbackSrc}';this.srcset='${fallbackSrcSet}';"
    />
  `;
}

function getCountryDisplayLabel(city) {
  if (city.country) {
    return city.country;
  }

  if (city.countryCode) {
    const countryLabel = getCountryLabelFromCode(city.countryCode.toUpperCase());
    if (countryLabel) {
      return countryLabel;
    }
  }

  if (city.regionName) {
    return city.regionName;
  }

  return 'Sem pais identificado';
}

function hasResolvedLocation(city) {
  return Boolean(city.country && city.countryCode && city.cityName);
}

function normalizeRatings(ratings) {
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

function normalizeRatingValue(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(5, Math.round(numeric)));
}

function getCityRatings(cityId) {
  return normalizeRatings(cityRatings[cityId]);
}

function getDisplayVisitedCityName(visitedCity) {
  const ratings = getCityRatings(visitedCity.id);
  return ratings.customName?.trim() || visitedCity.cityName;
}

function persistCityRatings() {
  localStorage.setItem('cityRatings', JSON.stringify(cityRatings));
}

function persistCollapsedCountries() {
  localStorage.setItem('collapsedCountries', JSON.stringify(collapsedCountries));
}

function setActiveTab(tab) {
  activeTab = tab;
  const showTrips = tab === 'trips';

  tripsTabBtn.classList.toggle('active', showTrips);
  citiesTabBtn.classList.toggle('active', !showTrips);
  tripsTabEl.classList.toggle('active', showTrips);
  citiesTabEl.classList.toggle('active', !showTrips);
}

function syncVisitedOverlayButton() {
  visitedOverlayToggleBtn.classList.toggle('active', visitedOverlayEnabled);
  visitedOverlayToggleBtn.setAttribute('aria-pressed', String(visitedOverlayEnabled));
}

async function hydrateCompletedTrips() {
  for (let index = 0; index < trips.length; index++) {
    const trip = trips[index];
    if (trip.status !== 'completed') continue;
    if (trip.cities.some((city) => !hasResolvedLocation(city))) {
      await ensureTripLocations(trip, index);
    }
  }
}

function getDisplayCityName(city, index) {
  return (
    city.cityName ||
    city.regionName ||
    formatCoordinateLabel(city, index)
  );
}

function formatCoordinateLabel(city, index) {
  if (Number.isFinite(city.lat) && Number.isFinite(city.lng)) {
    return `Ponto ${index + 1} (${city.lat.toFixed(2)}, ${city.lng.toFixed(2)})`;
  }

  return `Ponto ${index + 1}`;
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function totalDistance(list) {
  let total = 0;

  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1];
    const b = list[i];

    total += distanceBetweenPointsKm(a.lat, a.lng, b.lat, b.lng);
  }

  return total;
}

function zoomToCities(list) {
  const validPoints = list.filter((city) => Number.isFinite(city.lat) && Number.isFinite(city.lng));
  if (!validPoints.length) return;

  if (validPoints.length === 1) {
    map.setView([validPoints[0].lat, validPoints[0].lng], 8, { animate: true });
    return;
  }

  const bounds = L.latLngBounds(validPoints.map((city) => [city.lat, city.lng]));
  map.fitBounds(bounds, {
    padding: [32, 32],
    maxZoom: 9,
    animate: true
  });
}

startNewTrip();
setActiveTab('trips');
renderTrips();
renderVisitedCitiesList();
void refreshVisitedCountriesLayer();
void hydrateCompletedTrips();

function distanceBetweenPointsKm(latA, lngA, latB, lngB) {
  const earthRadiusKm = 6371;
  const dLat = (latB - latA) * Math.PI / 180;
  const dLon = (lngB - lngA) * Math.PI / 180;

  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(latA * Math.PI / 180) *
    Math.cos(latB * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;

  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
