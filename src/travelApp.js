import {
  compareMonthAsc,
  compareMonthDesc,
  createVisitedCityId,
  distanceBetweenPointsKm,
  escapeHtml,
  formatTripMonth,
  getCountryDisplayLabel,
  getCountryEnglishLabelFromCode,
  getCountryLabelFromCode,
  getDisplayCityName,
  getDisplayVisitedCityName,
  getFlagMarkup,
  getSingleFlagMarkup,
  getTripCountryCodes,
  normalizeCountryName,
  normalizeOverlayCountryCode,
  renderRatingRow,
  totalDistance,
  zoomToCities
} from './lib/helpers.js';
import {
  createSerializableAppData,
  DEFAULT_TRIP_SORT,
  hasResolvedLocation,
  normalizeAppDataShape,
  normalizeCity,
  normalizeRatings,
  normalizeTripRecord
} from './lib/models.js';
import { applyResolvedLocation, createLocationService } from './lib/location.js';
import {
  canUseFileApi,
  downloadAppData,
  loadInitialAppData,
  saveAppData
} from './lib/appData.js';

const CITY_PROXIMITY_KM = 35;

export async function startApp() {
  const initialLoad = await loadInitialAppData();
  const initialData = normalizeAppDataShape(initialLoad.data);

  const map = L.map('map', { editable: true }).setView([-23.55, -46.63], 4);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd',
    maxZoom: 19
  }).addTo(map);

  const dom = getDomRefs();
  const pinIcon = L.divIcon({
    html: '<div style="font-size:32px;">&#128205;</div>',
    className: '',
    iconSize: [32, 32],
    iconAnchor: [16, 32]
  });

  const cities = [];
  const markers = [];
  const trips = initialData.trips.map((trip) => normalizeTripRecord(trip));
  const cityRatings = { ...initialData.cityRatings };
  const collapsedCountries = { ...initialData.collapsedCountries };

  let polyline = null;
  let selectedTripIndex = null;
  let tripSort = initialData.preferences.tripSort || DEFAULT_TRIP_SORT;
  let visitedOverlayEnabled = Boolean(initialData.preferences.visitedOverlayEnabled);
  let visitedCountriesLayer = null;
  let activeTab = 'trips';
  let worldGeoJsonCache = initialData.countriesGeoJson || null;
  let pendingSaveCount = 0;
  let deferredPersistTimer = null;
  let mapOverlayLoadCount = 0;

  const locationService = createLocationService({
    loadWorldGeoJson,
    getCountryLabelFromCode
  });

  syncCountriesFileStatus(
    worldGeoJsonCache
      ? 'Mapa de paises salvo em data/app-data.json'
      : 'Usando busca online para identificar paises'
  );
  syncAppDataStatus(
    initialLoad.source === 'legacy'
      ? 'Dados antigos do navegador migrados para data/app-data.json'
      : initialLoad.source === 'legacy-offline'
        ? 'API de arquivo indisponivel: usando dados antigos do navegador ate rodar pelo Vite'
      : 'Dados sincronizados com data/app-data.json'
  );

  dom.importCountriesBtn.onclick = () => dom.countriesFileInput.click();
  dom.countriesFileInput.onchange = handleCountriesImport;
  dom.importDataBtn.onclick = () => dom.appDataFileInput.click();
  dom.appDataFileInput.onchange = handleAppDataImport;
  dom.exportDataBtn.onclick = handleAppDataExport;
  dom.saveTripBtn.onclick = handleSaveTrip;
  dom.newTripBtn.onclick = () => {
    startNewTrip();
    renderTrips();
  };
  dom.clearGraphBtn.onclick = () => {
    clearCurrentRoute();
  };
  dom.tripSortInput.value = tripSort;
  dom.tripSortInput.onchange = () => {
    tripSort = dom.tripSortInput.value;
    void persistAppData('Ordenacao salva em data/app-data.json');
    renderTrips();
  };
  syncVisitedOverlayButton();
  dom.visitedOverlayToggleBtn.onclick = async () => {
    visitedOverlayEnabled = !visitedOverlayEnabled;
    syncVisitedOverlayButton();
    await persistAppData('Preferencia da camada salva em data/app-data.json');
    await refreshVisitedCountriesLayer();
  };
  dom.tripsTabBtn.onclick = () => setActiveTab('trips');
  dom.citiesTabBtn.onclick = () => setActiveTab('cities');

  map.on('click', async (event) => {
    const city = normalizeCity({ lat: event.latlng.lat, lng: event.latlng.lng });
    cities.push(city);
    redrawMarkers();
    redraw();
    await ensureCityDetails(city);
    redrawMarkers();
    redraw();
    await syncSelectedTripFromCities();
  });

  startNewTrip();
  setActiveTab('trips');
  renderTrips();
  renderVisitedCitiesList();
  await refreshVisitedCountriesLayer();
  await hydrateCompletedTrips();

  async function handleCountriesImport(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    syncCountriesFileStatus('Importando mapa de paises...');

    try {
      const geoJson = JSON.parse(await file.text());
      if (!geoJson?.features?.length) {
        throw new Error('Arquivo invalido');
      }

      worldGeoJsonCache = geoJson;
      locationService.clearCache();
      await persistAppData(`Mapa local carregado: ${file.name}`);

      if (selectedTripIndex !== null) {
        await ensureTripLocations(trips[selectedTripIndex], selectedTripIndex);
      }

      await hydrateCompletedTrips();
      renderTrips();
      renderVisitedCitiesList();
      await refreshVisitedCountriesLayer();
      syncCountriesFileStatus(`Mapa local carregado: ${file.name}`);
    } catch {
      syncCountriesFileStatus('Falha ao importar o arquivo de paises');
    } finally {
      dom.countriesFileInput.value = '';
    }
  }

  async function handleAppDataImport(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    syncAppDataStatus('Importando arquivo de dados...');

    try {
      const parsed = JSON.parse(await file.text());
      const imported = normalizeAppDataShape(parsed);
      await replaceAppState(imported);
      await persistAppData(`Dados importados de ${file.name}`);
      syncAppDataStatus(`Dados importados de ${file.name}`);
    } catch {
      syncAppDataStatus('Falha ao importar o arquivo de dados');
    } finally {
      dom.appDataFileInput.value = '';
    }
  }

  function handleAppDataExport() {
    downloadAppData(snapshotAppData());
    syncAppDataStatus('Arquivo de dados exportado');
  }

  async function handleSaveTrip() {
    const name = dom.tripNameInput.value.trim();
    if (!name) return;

    setSaveTripLoading(true);

    try {
      await Promise.all(cities.map((city) => ensureCityDetails(city)));

      const snapshot = cities.map((city) => ({ ...city }));
      const distance = totalDistance(snapshot);
      const existingTrip = selectedTripIndex !== null ? trips[selectedTripIndex] : null;
      const tripRecord = normalizeTripRecord({
        ...existingTrip,
        name,
        month: dom.tripMonthInput.value,
        status: dom.tripStatusInput.value,
        cities: snapshot,
        distance
      });

      if (selectedTripIndex !== null) {
        trips[selectedTripIndex] = tripRecord;
      } else {
        trips.push(tripRecord);
      }

      await persistAppData('Viagem salva em data/app-data.json');
      startNewTrip();
      renderTrips();
      renderVisitedCitiesList();
      await refreshVisitedCountriesLayer();
    } finally {
      setSaveTripLoading(false);
    }
  }

  function loadTrip(index) {
    const trip = trips[index];
    if (!trip) return;

    selectedTripIndex = index;
    dom.tripNameInput.value = trip.name;
    dom.tripMonthInput.value = trip.month;
    dom.tripStatusInput.value = trip.status;

    cities.length = 0;
    trip.cities.forEach((city) => cities.push(normalizeCity(city)));

    redrawMarkers();
    redraw();
    updateTripMode();
    zoomToCities(map, cities);
    renderTrips();
    renderVisitedCitiesList();
    void ensureTripLocations(trip, index);
  }

  function renderTrips() {
    dom.tripList.innerHTML = '';

    getSortedTrips().forEach(({ trip, index }) => {
      const li = document.createElement('li');
      const flagMarkup = getFlagMarkup(getTripCountryCodes(trip));
      const dateLabel = formatTripMonth(trip.month);
      const statusLabel = trip.status === 'completed' ? 'Concluido' : 'Planejado';
      const tripRating = getTripAverageRating(trip);
      const isExpanded = index === selectedTripIndex;
      const tripCitiesMarkup = isExpanded ? renderTripCitiesSummaryMarkup(trip) : '';
      const tripRatingMarkup = trip.status === 'completed'
        ? `<span class="trip-rating">${tripRating ? `Media ${tripRating.toFixed(1)} ★` : 'Sem notas'}</span>`
        : '';

      li.innerHTML = `
        <div class="trip-card ${isExpanded ? 'trip-active trip-expanded' : ''}">
          <div class="trip-card-header">
            <div>
              <strong>${escapeHtml(trip.name)}</strong><br>
              <small class="trip-submeta">
                <span>${dateLabel}</span>
                <span class="status-badge status-${trip.status}">${statusLabel}</span>
              </small>
              <br>
              <small class="trip-meta">
                ${tripRatingMarkup}
                ${flagMarkup}
              </small>
            </div>
            <button class="btn danger deleteBtn" type="button" aria-label="Excluir viagem">&#128465;</button>
          </div>
          ${tripCitiesMarkup}
        </div>
      `;

      li.onclick = () => loadTrip(index);
      li.querySelector('.deleteBtn').onclick = async (event) => {
        event.stopPropagation();

        trips.splice(index, 1);
        if (selectedTripIndex === index) {
          startNewTrip();
        } else if (selectedTripIndex > index) {
          selectedTripIndex -= 1;
        }

        await persistAppData('Viagem removida de data/app-data.json');
        updateTripMode();
        renderTrips();
        renderVisitedCitiesList();
        await refreshVisitedCountriesLayer();
      };

      dom.tripList.appendChild(li);
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
        const position = event.target.getLatLng();
        city.lat = position.lat;
        city.lng = position.lng;
        redraw();
        await ensureCityDetails(city);
        redrawMarkers();
        redraw();
        await syncSelectedTripFromCities();
      });

      marker.on('contextmenu', async () => {
        const markerIndex = markers.indexOf(marker);
        markers.splice(markerIndex, 1);
        cities.splice(markerIndex, 1);
        map.removeLayer(marker);
        redraw();
        await syncSelectedTripFromCities();
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
    await syncSelectedTripFromCities();
  }

  async function ensureTripLocations(trip, index) {
    if (!trip?.cities?.length || trip.cities.every(hasResolvedLocation)) return;

    let changed = false;
    const previousDistance = trip.distance || 0;

    await Promise.all(
      trip.cities.map(async (city) => {
        const normalized = normalizeCity(city);
        if (!hasResolvedLocation(normalized)) {
          const resolved = await locationService.reverseGeocodeLocation(normalized.lat, normalized.lng);
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
      await persistAppData('Localizacoes atualizadas em data/app-data.json');
    }

    if (selectedTripIndex === index) {
      syncCitiesFromSelectedTrip();
      redrawMarkers();
      redraw();
    }

    if (changed || distanceChanged) {
      renderTrips();
      renderVisitedCitiesList();
      await refreshVisitedCountriesLayer();
    }
  }

  function startNewTrip() {
    selectedTripIndex = null;
    dom.tripNameInput.value = '';
    dom.tripMonthInput.value = '';
    dom.tripStatusInput.value = 'planned';
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

  }

  function updateTripMode() {
    if (selectedTripIndex === null) {
      dom.tripModeEl.textContent = 'Criando uma nova viagem';
      dom.tripHelpEl.textContent = 'Clique no mapa para adicionar pontos. Use o botao direito em um ponto para excluir.';
      return;
    }

    const trip = trips[selectedTripIndex];
    dom.tripModeEl.textContent = `Editando: ${trip?.name || 'viagem atual'}`;
    dom.tripHelpEl.textContent = 'Arraste os pontos para ajustar a rota. Use o botao direito em um ponto para excluir.';
  }

  async function ensureCityDetails(city) {
    if (hasResolvedLocation(city)) return city;

    const resolved = await locationService.reverseGeocodeLocation(city.lat, city.lng);
    if (!resolved) return city;

    const changed = applyResolvedLocation(city, resolved);
    if (changed) {
      if (selectedTripIndex !== null) {
        await syncSelectedTripFromCities();
      }

      renderTrips();
      renderVisitedCitiesList();
      await refreshVisitedCountriesLayer();
    }

    return city;
  }

  function getSortedTrips() {
    const sorted = trips.map((trip, index) => ({ trip, index }));

    sorted.sort((left, right) => {
      if (tripSort === 'name-asc') {
        return left.trip.name.localeCompare(right.trip.name, 'pt-BR');
      }

      if (tripSort === 'status') {
        const statusOrder = { planned: 0, completed: 1 };
        const statusDiff = statusOrder[left.trip.status] - statusOrder[right.trip.status];
        return statusDiff || compareMonthDesc(left.trip.month, right.trip.month);
      }

      if (tripSort === 'date-asc') {
        return compareMonthAsc(left.trip.month, right.trip.month);
      }

      return compareMonthDesc(left.trip.month, right.trip.month);
    });

    return sorted;
  }

  function updateMarkerTooltip(marker, city) {
    const locationLabel = city.cityName || city.country || 'Local da rota';
    const detail = city.cityName && city.country ? `, ${city.country}` : '';
    marker.bindTooltip(`${locationLabel}${detail}`, { direction: 'top' });
  }

  async function syncSelectedTripFromCities() {
    if (selectedTripIndex === null) return;

    const trip = trips[selectedTripIndex];
    if (!trip) return;

    trip.cities = cities.map((city) => ({ ...city }));
    trip.distance = totalDistance(cities);
    trip.month = dom.tripMonthInput.value;
    trip.status = dom.tripStatusInput.value;
    await persistAppData('Rota atualizada em data/app-data.json');
    renderTrips();
    renderVisitedCitiesList();
    await refreshVisitedCountriesLayer();
  }

  function syncCitiesFromSelectedTrip() {
    if (selectedTripIndex === null) return;

    const trip = trips[selectedTripIndex];
    if (!trip) return;

    cities.length = 0;
    trip.cities.forEach((city) => cities.push(normalizeCity(city)));
  }

  async function refreshVisitedCountriesLayer() {
    mapOverlayLoadCount += 1;
    syncMapOverlayLoading();

    try {
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
    if (!visitedCodes.size && !visitedNames.size) {
      if (visitedCountriesLayer) {
        map.removeLayer(visitedCountriesLayer);
        visitedCountriesLayer = null;
      }
      setVisitedOverlayStatus('Nenhum pais identificado nas viagens ainda');
      return;
    }

    setVisitedOverlayStatus(`Carregando ${Math.max(visitedCodes.size, visitedNames.size)} pais(es)...`);
    const geoJson = await loadWorldGeoJson();
    if (!geoJson) {
      setVisitedOverlayStatus('Nao foi possivel carregar os contornos dos paises');
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
      setVisitedOverlayStatus(`Nenhum poligono encontrado para ${Math.max(visitedCodes.size, visitedNames.size)} pais(es)`);
      return;
    }

    setVisitedOverlayStatus(`${matchedCountries.size} pais(es) destacados no mapa`);
    } finally {
      mapOverlayLoadCount = Math.max(0, mapOverlayLoadCount - 1);
      syncMapOverlayLoading();
    }
  }

  function getVisitedCountryCodes() {
    const codes = new Set();
    trips
      .filter((trip) => trip.status === 'completed')
      .forEach((trip) => {
      getTripCountryCodes(trip).forEach((code) => codes.add(normalizeOverlayCountryCode(code)));
      });

    return codes;
  }

  function getVisitedCountryNames() {
    const names = new Set();

    trips
      .filter((trip) => trip.status === 'completed')
      .forEach((trip) => {
        (trip.cities || []).forEach((city) => {
          const canonicalName = getCanonicalCountryName(city);
          if (canonicalName) {
            names.add(canonicalName);
          }
        });
      });

    return names;
  }

  async function loadWorldGeoJson() {
    if (worldGeoJsonCache) {
      return worldGeoJsonCache;
    }

    const localSources = ['./countries.geojson', '/countries.geojson'];
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

    const remoteSources = [
      'https://datahub.io/core/geo-boundaries-world-110m/r/countries.geojson',
      'https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson',
      'https://cdn.jsdelivr.net/gh/datasets/geo-countries@master/data/countries.geojson'
    ];

    for (const source of remoteSources) {
      try {
        const response = await fetch(source);
        if (!response.ok) continue;
        const geoJson = await response.json();
        if (!geoJson?.features?.length) continue;
        worldGeoJsonCache = geoJson;
        syncCountriesFileStatus('Mapa de paises carregado online');
        return geoJson;
      } catch {
        continue;
      }
    }

    return null;
  }

  function renderVisitedCitiesList() {
    const visitedCities = buildVisitedCityGroups();

    if (!visitedCities.length) {
      dom.cityListStatusEl.textContent = 'Use viagens concluidas para montar a lista';
      dom.cityListEl.innerHTML = '<div class="city-empty">Nenhuma cidade concluida identificada ainda. Se as viagens ja estao concluidas, abra uma delas para enriquecer os pontos com localizacao.</div>';
      return;
    }

    dom.cityListStatusEl.textContent = `${visitedCities.length} cidade(s) visitada(s)`;
    dom.cityListEl.innerHTML = '';

    groupVisitedCitiesByCountry(visitedCities).forEach((countryGroup) => {
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

      wrapper.querySelector('.country-toggle').onclick = async () => {
        collapsedCountries[countryGroup.key] = !isCollapsed;
        renderVisitedCitiesList();
        schedulePersistAppData('Preferencia da lista de cidades salva em data/app-data.json');
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
                <span class="city-name">${escapeHtml(getDisplayVisitedCityName(visitedCity, getCityRatings))}</span>
                <small class="city-country">
                  ${flagMarkup}
                  <span>${escapeHtml(visitedCity.countryLabel)}</span>
                </small>
              </div>
            </div>
            <div class="city-card-actions">
              <button class="city-toggle-btn ${ratings.isCity !== false ? 'active' : ''}" type="button" aria-label="Alternar tipo de local" title="${ratings.isCity !== false ? 'Cidade visitavel com categorias' : 'Local com nota geral'}">&#127961;</button>
              <button class="icon-btn zoom-city-btn" type="button" aria-label="Centralizar cidade" title="Ver no mapa">&#128269;</button>
              <button class="icon-btn edit-city-btn" type="button" aria-label="Editar cidade" title="Editar cidade">&#9998;</button>
            </div>
          </div>
          <div class="city-ratings">
            ${ratings.isCity !== false
              ? [
                renderRatingRow('cuisine', 'Culinaria', ratings.cuisine),
                renderRatingRow('museums', 'Museus', ratings.museums),
                renderRatingRow('monuments', 'Monumentos', ratings.monuments),
                renderRatingRow('walkable', 'Andavel', ratings.walkable)
              ].join('')
              : renderRatingRow('overall', 'Nota geral', ratings.overall)}
          </div>
          <div class="city-rename">
            <input class="rename-city-input" type="text" value="${escapeHtml(getDisplayVisitedCityName(visitedCity, getCityRatings))}" placeholder="Renomear cidade" />
            <button class="icon-btn save-city-name-btn" type="button" aria-label="Salvar nome" title="Salvar nome">&#10003;</button>
            <button class="icon-btn cancel-city-name-btn" type="button" aria-label="Cancelar edicao" title="Cancelar edicao">&#8630;</button>
          </div>
        `;

        card.querySelector('.zoom-city-btn').onclick = () => {
          map.setView([visitedCity.lat, visitedCity.lng], 10, { animate: true });
        };

        card.querySelector('.city-toggle-btn').onclick = async () => {
          const nextRatings = { ...getCityRatings(visitedCity.id) };
          nextRatings.isCity = nextRatings.isCity === false;
          cityRatings[visitedCity.id] = normalizeRatings(nextRatings);
          renderVisitedCitiesList();
          schedulePersistAppData('Avaliacao de cidade salva em data/app-data.json');
        };

        card.querySelectorAll('.star-btn').forEach((button) => {
          button.onclick = async () => {
            const category = button.dataset.category;
            const value = Number(button.dataset.value);
            const nextRatings = { ...getCityRatings(visitedCity.id) };
            nextRatings[category] = nextRatings[category] === value ? 0 : value;
            cityRatings[visitedCity.id] = normalizeRatings(nextRatings);
            renderVisitedCitiesList();
            schedulePersistAppData('Avaliacao de cidade salva em data/app-data.json');
          };
        });

        card.querySelector('.edit-city-btn').onclick = () => {
          const renameBox = card.querySelector('.city-rename');
          renameBox.classList.add('open');
          card.querySelector('.rename-city-input').focus();
        };

        card.querySelector('.save-city-name-btn').onclick = async () => {
          const input = card.querySelector('.rename-city-input');
          const customName = input.value.trim();
          const nextRatings = { ...getCityRatings(visitedCity.id) };
          nextRatings.customName = customName;
          cityRatings[visitedCity.id] = normalizeRatings(nextRatings);
          renderVisitedCitiesList();
          schedulePersistAppData('Nome personalizado salvo em data/app-data.json');
        };

        card.querySelector('.cancel-city-name-btn').onclick = () => {
          card.querySelector('.city-rename').classList.remove('open');
        };

        countryCitiesEl.appendChild(card);
      });

      dom.cityListEl.appendChild(wrapper);
    });
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

    groups.sort((left, right) => left.cityName.localeCompare(right.cityName, 'pt-BR'));
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

      if (groupName || cityName) {
        return false;
      }

      return distance <= CITY_PROXIMITY_KM;
    }) || null;
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

    return [...groups.values()].sort((left, right) => left.label.localeCompare(right.label, 'pt-BR'));
  }

  function upgradeVisitedCityGroupLocation(group, city) {
    if (!group.countryCode && city.countryCode) {
      group.countryCode = city.countryCode;
    }

    const nextCountryLabel = getCountryDisplayLabel(city);
    const hasMissingLabel = !group.countryLabel || group.countryLabel === 'Sem pais identificado';

    if (hasMissingLabel && nextCountryLabel && nextCountryLabel !== 'Sem pais identificado') {
      group.countryLabel = nextCountryLabel;
    }
  }

  function getCityRatings(cityId) {
    return normalizeRatings(cityRatings[cityId]);
  }

  function getTripAverageRating(trip) {
    const cityScores = (trip.cities || [])
      .map((city) => getCityScore(createVisitedCityId(city)))
      .filter((score) => score > 0);

    if (!cityScores.length) {
      return null;
    }

    const total = cityScores.reduce((sum, score) => sum + score, 0);
    return total / cityScores.length;
  }

  function renderTripCitiesSummaryMarkup(trip) {
    const items = buildTripCitySummaries(trip).map((citySummary) => {
      const scoreLabel = citySummary.score > 0 ? `${citySummary.score.toFixed(1)} ★` : 'Sem nota';
      const countLabel = citySummary.count > 1 ? `<span class="trip-city-count">${citySummary.count}x</span>` : '';

      return `
        <li class="trip-city-item">
          <span class="trip-city-name">${escapeHtml(citySummary.label)}</span>
          <span class="trip-city-score">${scoreLabel}</span>
          ${countLabel}
        </li>
      `;
    }).join('');

    if (!items) {
      return '<div class="trip-city-panel"><div class="trip-city-empty">Nenhum ponto nesta viagem.</div></div>';
    }

    return `
      <div class="trip-city-panel">
        <div class="trip-city-panel-title">Cidades da viagem</div>
        <ul class="trip-city-list">${items}</ul>
      </div>
    `;
  }

  function buildTripCitySummaries(trip) {
    const summaries = [];

    (trip.cities || []).forEach((city, index) => {
      const cityId = createVisitedCityId(city);
      const ratings = getCityRatings(cityId);
      const customName = ratings.customName?.trim();
      const baseLabel = customName || city.cityName || city.regionName || `Ponto ${index + 1}`;
      const normalizedLabel = normalizeCountryName(baseLabel);
      const countryCode = city.countryCode?.toLowerCase() || '';
      const score = getCityScore(cityId);

      const existing = summaries.find((summary) => {
        if (summary.countryCode !== countryCode) {
          return false;
        }

        if (summary.normalizedLabel && normalizedLabel) {
          return summary.normalizedLabel === normalizedLabel;
        }

        const distance = distanceBetweenPointsKm(summary.lat, summary.lng, city.lat, city.lng);
        return distance <= 2;
      });

      if (existing) {
        existing.count += 1;
        if (score > existing.score) {
          existing.score = score;
        }
        if (!existing.customName && customName) {
          existing.label = customName;
          existing.customName = true;
          existing.normalizedLabel = normalizeCountryName(customName);
        }
        return;
      }

      summaries.push({
        label: baseLabel,
        normalizedLabel,
        countryCode,
        lat: city.lat,
        lng: city.lng,
        score,
        count: 1,
        customName: Boolean(customName)
      });
    });

    return summaries;
  }

  function renderTripCitiesMarkup(trip) {
    const items = (trip.cities || []).map((city, index) => {
      const cityLabel = city.cityName || city.regionName || `Ponto ${index + 1}`;
      const score = getCityScore(createVisitedCityId(city));
      const scoreLabel = score > 0 ? `${score.toFixed(1)} ★` : 'Sem nota';

      return `
        <li class="trip-city-item">
          <span class="trip-city-name">${escapeHtml(cityLabel)}</span>
          <span class="trip-city-score">${scoreLabel}</span>
        </li>
      `;
    }).join('');

    if (!items) {
      return '<div class="trip-city-panel"><div class="trip-city-empty">Nenhum ponto nesta viagem.</div></div>';
    }

    return `
      <div class="trip-city-panel">
        <div class="trip-city-panel-title">Cidades da viagem</div>
        <ul class="trip-city-list">${items}</ul>
      </div>
    `;
  }

  function getCityScore(cityId) {
    const ratings = getCityRatings(cityId);

    if (ratings.isCity === false) {
      return ratings.overall || 0;
    }

    const values = [
      ratings.cuisine,
      ratings.museums,
      ratings.monuments,
      ratings.walkable
    ].filter((value) => value > 0);

    if (!values.length) {
      return 0;
    }

    const total = values.reduce((sum, value) => sum + value, 0);
    return total / values.length;
  }

  function setActiveTab(tab) {
    activeTab = tab;
    const showTrips = activeTab === 'trips';

    dom.tripsTabBtn.classList.toggle('active', showTrips);
    dom.citiesTabBtn.classList.toggle('active', !showTrips);
    dom.tripsTabEl.classList.toggle('active', showTrips);
    dom.citiesTabEl.classList.toggle('active', !showTrips);
  }

  function syncVisitedOverlayButton() {
    dom.visitedOverlayToggleBtn.classList.toggle('active', visitedOverlayEnabled);
    dom.visitedOverlayToggleBtn.setAttribute('aria-pressed', String(visitedOverlayEnabled));
  }

  async function hydrateCompletedTrips() {
    for (let index = 0; index < trips.length; index += 1) {
      const trip = trips[index];
      if (trip.status !== 'completed') continue;
      if (trip.cities.some((city) => !hasResolvedLocation(city))) {
        await ensureTripLocations(trip, index);
      }
    }
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

  function getCanonicalCountryName(city) {
    const code = city.countryCode ? normalizeOverlayCountryCode(city.countryCode) : null;
    if (code) {
      const label = getCountryEnglishLabelFromCode(code);
      if (label) {
        return normalizeCountryName(label);
      }
    }

    return city.country ? normalizeCountryName(city.country) : null;
  }

  function setVisitedOverlayStatus(message) {
    dom.visitedOverlayStatusEl.textContent = message;
    syncVisitedOverlayButton();
  }

  function syncCountriesFileStatus(message) {
    dom.countriesFileStatusEl.textContent = message;
  }

  function syncAppDataStatus(message) {
    dom.appDataStatusEl.textContent = message;
  }

  function syncMapOverlayLoading() {
    dom.mapLoadingOverlayEl.classList.toggle('active', mapOverlayLoadCount > 0);
  }

  function snapshotAppData() {
    return createSerializableAppData({
      trips,
      cityRatings,
      collapsedCountries,
      tripSort,
      visitedOverlayEnabled,
      countriesGeoJson: worldGeoJsonCache
    });
  }

  function schedulePersistAppData(successMessage, delayMs = 250) {
    if (deferredPersistTimer) {
      clearTimeout(deferredPersistTimer);
    }

    deferredPersistTimer = window.setTimeout(() => {
      deferredPersistTimer = null;
      void persistAppData(successMessage);
    }, delayMs);
  }

  async function persistAppData(successMessage) {
    if (deferredPersistTimer) {
      clearTimeout(deferredPersistTimer);
      deferredPersistTimer = null;
    }

    pendingSaveCount += 1;
    syncSavingIndicator();

    try {
      if (!(await canUseFileApi())) {
        syncAppDataStatus('API de arquivo indisponivel. Rode com npm run dev para salvar em data/app-data.json');
        return false;
      }

      await saveAppData(snapshotAppData());
      if (successMessage) {
        syncAppDataStatus(successMessage);
      }

      return true;
    } finally {
      pendingSaveCount = Math.max(0, pendingSaveCount - 1);
      syncSavingIndicator();
    }
  }

  async function replaceAppState(nextData) {
    trips.splice(0, trips.length, ...nextData.trips.map((trip) => normalizeTripRecord(trip)));
    replaceObject(cityRatings, nextData.cityRatings);
    replaceObject(collapsedCountries, nextData.collapsedCountries);
    tripSort = nextData.preferences.tripSort || DEFAULT_TRIP_SORT;
    visitedOverlayEnabled = Boolean(nextData.preferences.visitedOverlayEnabled);
    worldGeoJsonCache = nextData.countriesGeoJson || null;
    locationService.clearCache();

    dom.tripSortInput.value = tripSort;
    syncVisitedOverlayButton();
    syncCountriesFileStatus(
      worldGeoJsonCache
        ? 'Mapa de paises salvo em data/app-data.json'
        : 'Usando busca online para identificar paises'
    );

    startNewTrip();
    setActiveTab(activeTab);
    renderTrips();
    renderVisitedCitiesList();
    await refreshVisitedCountriesLayer();
    await hydrateCompletedTrips();
  }

  function setSaveTripLoading(isLoading) {
    dom.saveTripBtn.disabled = isLoading;
    dom.saveTripBtn.classList.toggle('is-loading', isLoading);
    dom.saveTripBtn.textContent = isLoading ? 'Salvando...' : 'Salvar';
  }

  function syncSavingIndicator() {
    dom.appDataStatusEl.classList.toggle('is-loading', pendingSaveCount > 0);
  }
}

function replaceObject(target, source) {
  Object.keys(target).forEach((key) => delete target[key]);
  Object.assign(target, source);
}

function getDomRefs() {
  return {
    tripNameInput: document.getElementById('tripName'),
    tripMonthInput: document.getElementById('tripMonth'),
    tripStatusInput: document.getElementById('tripStatus'),
    tripList: document.getElementById('tripList'),
    cityListEl: document.getElementById('cityList'),
    cityListStatusEl: document.getElementById('cityListStatus'),
    tripSortInput: document.getElementById('tripSort'),
    tripModeEl: document.getElementById('tripMode'),
    tripHelpEl: document.getElementById('tripHelp'),
    newTripBtn: document.getElementById('newTrip'),
    saveTripBtn: document.getElementById('saveTrip'),
    clearGraphBtn: document.getElementById('clearGraph'),
    visitedOverlayToggleBtn: document.getElementById('visitedOverlayToggle'),
    visitedOverlayStatusEl: document.getElementById('visitedOverlayStatus'),
    tripsTabBtn: document.getElementById('tripsTabBtn'),
    citiesTabBtn: document.getElementById('citiesTabBtn'),
    tripsTabEl: document.getElementById('tripsTab'),
    citiesTabEl: document.getElementById('citiesTab'),
    importCountriesBtn: document.getElementById('importCountriesBtn'),
    countriesFileInput: document.getElementById('countriesFileInput'),
    countriesFileStatusEl: document.getElementById('countriesFileStatus'),
    importDataBtn: document.getElementById('importDataBtn'),
    exportDataBtn: document.getElementById('exportDataBtn'),
    appDataFileInput: document.getElementById('appDataFileInput'),
    appDataStatusEl: document.getElementById('appDataStatus'),
    mapLoadingOverlayEl: document.getElementById('mapLoadingOverlay')
  };
}
