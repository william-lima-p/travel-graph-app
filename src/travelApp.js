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
  createDefaultAppData,
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
  let initialLoad = { data: createDefaultAppData(), source: 'empty' };
  let initialData = normalizeAppDataShape(initialLoad.data);
  let initialLoadError = null;

  try {
    initialLoad = await loadInitialAppData();
    initialData = normalizeAppDataShape(initialLoad.data);
  } catch (error) {
    initialLoadError = error;
  }

  const map = L.map('map', { editable: true }).setView([-23.55, -46.63], 4);
  const lightTileLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd',
    maxZoom: 19
  });
  const darkTileLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd',
    maxZoom: 19
  });
  lightTileLayer.addTo(map);

  const dom = getDomRefs();
  const pinIcon = L.divIcon({
    html: `
      <div class="map-pin" aria-hidden="true">
        <svg viewBox="0 0 24 24" role="img" focusable="false">
          <path d="M12 22L6 13.2C4.8 11.5 4 9.7 4 8.2C4 4.8 7.6 2 12 2C16.4 2 20 4.8 20 8.2C20 9.7 19.2 11.5 18 13.2L12 22Z" fill="#dc2626"/>
        </svg>
      </div>
    `,
    className: 'map-pin-wrapper',
    iconSize: [22, 24],
    iconAnchor: [11, 22]
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
  let visitedOverlayMode = initialData.preferences.visitedOverlayMode || 'country';
  let theme = initialData.preferences.theme || 'light';
  let tripEditorCollapsed = true;
  let visitedCountriesLayer = null;
  let activeTab = 'trips';
  let worldGeoJsonCache = null;
  let editingTripIndex = null;
  let savingEditedTrip = false;
  let renamingVisitedCityId = null;
  let pendingSaveCount = 0;
  let deferredPersistTimer = null;
  let mapOverlayLoadCount = 0;
  let mapOverlayRefreshToken = 0;
  const regionGeoJsonCache = new Map();
  const countryFeatureMatchCache = new Map();

  const locationService = createLocationService({
    loadWorldGeoJson,
    getCountryLabelFromCode
  });

  const migratedLegacyRatings = migrateLegacyCityRatings();

  syncAppDataStatus(
    initialLoadError
      ? 'Falha ao carregar os dados iniciais. A interface foi aberta em modo vazio.'
      : migratedLegacyRatings
      ? 'Notas antigas recuperadas e sincronizadas com o formato atual'
      : initialLoad.source === 'merged-legacy-ratings'
        ? 'Notas do navegador foram mescladas ao arquivo atual'
      : initialLoad.source === 'merged-legacy-ratings-offline'
        ? 'Notas do navegador foram recuperadas localmente, mas a API de arquivo esta indisponivel'
      : initialLoad.source === 'legacy'
      ? 'Dados antigos do navegador migrados para data/app-data.json'
      : initialLoad.source === 'legacy-offline'
        ? 'API de arquivo indisponivel: usando dados antigos do navegador ate rodar pelo Vite'
      : 'Dados sincronizados com data/app-data.json'
  );

  dom.importDataBtn.onclick = () => dom.appDataFileInput.click();
  dom.appDataFileInput.onchange = handleAppDataImport;
  dom.exportDataBtn.onclick = handleAppDataExport;
  dom.saveTripBtn.onclick = handleSaveTrip;
  dom.saveEditTripBtn.onclick = handleSaveEditedTrip;
  dom.cancelEditTripBtn.onclick = () => closeEditTripModal();
  dom.closeEditTripModalBtn.onclick = () => closeEditTripModal();
  dom.newTripBtn.onclick = () => {
    startNewTrip({ openEditor: true });
    renderTrips();
  };
  dom.clearGraphBtn.onclick = () => {
    clearCurrentRoute();
  };
  dom.tripEditorToggleBtn.onclick = () => {
    setTripEditorCollapsed(!tripEditorCollapsed);
  };
  dom.tripSortInput.value = tripSort;
  applyTheme();
  setTripEditorCollapsed(tripEditorCollapsed);
  dom.tripSortInput.onchange = () => {
    tripSort = dom.tripSortInput.value;
    void persistAppData('Ordenacao salva em data/app-data.json');
    renderTrips();
  };
  dom.themeToggleBtn.onclick = () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    applyTheme();
    schedulePersistAppData('Tema salvo em data/app-data.json');
  };
  syncVisitedOverlayButton();
  syncVisitedOverlayModeButton();
  dom.visitedOverlayToggleBtn.onclick = async () => {
    visitedOverlayEnabled = !visitedOverlayEnabled;
    syncVisitedOverlayButton();
    await persistAppData('Preferencia da camada salva em data/app-data.json');
    await refreshVisitedCountriesLayer();
  };
  dom.visitedOverlayModeToggleBtn.onclick = async () => {
    visitedOverlayMode = visitedOverlayMode === 'region' ? 'country' : 'region';
    syncVisitedOverlayModeButton();
    syncVisitedOverlayButton();
    await persistAppData('Modo da camada salvo em data/app-data.json');
    await refreshVisitedCountriesLayer();
  };
  dom.tripsTabBtn.onclick = () => setActiveTab('trips');
  dom.citiesTabBtn.onclick = () => setActiveTab('cities');
  dom.editTripModal.onclick = (event) => {
    if (!savingEditedTrip && event.target === dom.editTripModal) {
      closeEditTripModal();
    }
  };
  bindMonthPickerToggle(dom.tripMonthInput);
  bindMonthPickerToggle(dom.editTripMonthInput);

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

  startNewTrip({ openEditor: false });
  setActiveTab('trips');
  renderTrips();
  renderVisitedCitiesList();
  await refreshVisitedCountriesLayer();
  await hydrateCompletedTrips();
  if (migratedLegacyRatings) {
    schedulePersistAppData('Notas antigas recuperadas em data/app-data.json', 0);
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

  function bindMonthPickerToggle(input) {
    if (!input) return;

    const toggle = document.querySelector(`.month-picker-toggle[data-target="${input.id}"]`);
    if (!toggle) return;

    let pickerOpen = false;

    input.addEventListener('blur', () => {
      pickerOpen = false;
    });

    input.addEventListener('change', () => {
      pickerOpen = false;
    });

    toggle.addEventListener('click', (event) => {
      event.preventDefault();

      if (pickerOpen) {
        input.blur();
        pickerOpen = false;
        return;
      }

      input.focus();
      if (typeof input.showPicker === 'function') {
        input.showPicker();
      }
      pickerOpen = true;
    });
  }

  async function handleSaveTrip() {
    const name = dom.tripNameInput.value.trim();
    if (!name) return;

    setSaveTripLoading(true);

    try {
      await Promise.all(cities.map((city) => ensureCityDetails(city)));

      const snapshot = cities.map((city) => ({ ...city }));
      const distance = totalDistance(snapshot);
      const tripRecord = normalizeTripRecord({
        name,
        month: dom.tripMonthInput.value,
        status: dom.tripStatusInput.value,
        cities: snapshot,
        distance
      });

      trips.push(tripRecord);

      await persistAppData('Viagem salva em data/app-data.json');
      startNewTrip();
      renderTrips();
      renderVisitedCitiesList();
      await refreshVisitedCountriesLayer();
    } finally {
      setSaveTripLoading(false);
    }
  }

  async function loadTrip(index) {
    if (selectedTripIndex === index) {
      startNewTrip();
      renderTrips();
      renderVisitedCitiesList();
      void refreshVisitedCountriesLayer();
      return;
    }

    const trip = trips[index];
    if (!trip) return;

    selectedTripIndex = index;

    cities.length = 0;
    trip.cities.forEach((city) => cities.push(normalizeCity(city)));

    redrawMarkers();
    redraw();
    updateTripMode();
    zoomToCities(map, cities);
    renderTrips();
    renderVisitedCitiesList();
    void refreshVisitedCountriesLayer();
    void ensureTripLocations(trip, index, { force: trip.status === 'planned' });
  }

  function renderTrips() {
    dom.tripList.innerHTML = '';

    if (!trips.length) {
      dom.tripList.innerHTML = '<li class="city-empty">Adicione uma nova viagem para começar</li>';
      return;
    }

    getSortedTrips().forEach(({ trip, index }) => {
      const li = document.createElement('li');
      const flagMarkup = getFlagMarkup(getTripCountryCodes(trip));
      const dateLabel = formatTripMonth(trip.month);
      const statusLabel = trip.status === 'completed' ? 'Concluído' : 'Planejado';
      const tripDistance = Number.isFinite(trip.distance) ? trip.distance : totalDistance(trip.cities || []);
      const tripRating = getTripAverageRating(trip);
      const isExpanded = index === selectedTripIndex;
      const tripCitiesMarkup = isExpanded ? renderTripCitiesSummaryMarkup(trip) : '';
      const tripRatingMarkup = trip.status === 'completed'
        ? `<span class="trip-rating">${tripRating ? `${tripRating.toFixed(1)} ★` : 'Sem notas'}</span>`
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
                <span>${tripDistance.toFixed(1)} km</span>
                ${tripRatingMarkup}
                ${flagMarkup}
              </small>
            </div>
            <div class="trip-card-actions">
              <button class="btn secondary editTripBtn" type="button" aria-label="Editar viagem" title="Editar viagem">✎</button>
              <button class="btn danger deleteBtn" type="button" aria-label="Excluir viagem">×</button>
            </div>
          </div>
          ${tripCitiesMarkup}
        </div>
      `;

      li.onclick = () => loadTrip(index);
      li.querySelector('.editTripBtn').onclick = (event) => {
        event.stopPropagation();
        openEditTripModal(index);
      };
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
        color: '#1d4ed8',
        weight: 4,
        opacity: 0.9,
        dashArray: '12 8',
        lineCap: 'butt',
        lineJoin: 'miter'
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

      marker.on('contextmenu', async (event) => {
        event?.originalEvent?.preventDefault?.();
        event?.originalEvent?.stopPropagation?.();

        const markerIndex = markers.indexOf(marker);
        const cityIndex = cities.indexOf(city);

        if (markerIndex >= 0) {
          markers.splice(markerIndex, 1);
        }

        if (cityIndex >= 0) {
          cities.splice(cityIndex, 1);
        }

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

  async function ensureTripLocations(trip, index, { force = false } = {}) {
    if (!trip?.cities?.length || (!force && trip.cities.every(hasResolvedLocation))) return;

    let changed = false;
    const previousDistance = trip.distance || 0;

    await Promise.all(
      trip.cities.map(async (city) => {
        const normalized = normalizeCity(city);
        if (force || !hasResolvedLocation(normalized)) {
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

  function startNewTrip({ openEditor = false } = {}) {
    selectedTripIndex = null;
    setTripEditorCollapsed(!openEditor);
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
      dom.tripEditorToggleLabelEl.textContent = 'Nova viagem';
      return;
    }

    const trip = trips[selectedTripIndex];
    dom.tripModeEl.textContent = `Rota carregada: ${trip?.name || 'viagem atual'}`;
    dom.tripHelpEl.textContent = 'Arraste os pontos para ajustar a rota. Use o botao direito em um ponto para excluir. Use "Editar" no card para alterar nome, data e status.';
    dom.tripEditorToggleLabelEl.textContent = 'Nova viagem';
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
    await persistAppData('Rota atualizada em data/app-data.json');
    renderTrips();
    renderVisitedCitiesList();
    await refreshVisitedCountriesLayer();
  }

  function openEditTripModal(index) {
    const trip = trips[index];
    if (!trip) return;

    editingTripIndex = index;
    setSaveEditTripLoading(false);
    dom.editTripNameInput.value = trip.name || '';
    dom.editTripMonthInput.value = trip.month || '';
    dom.editTripStatusInput.value = trip.status || 'planned';
    dom.editTripModal.hidden = false;
    dom.editTripModal.classList.add('open');
  }

  function closeEditTripModal() {
    if (savingEditedTrip) {
      return;
    }

    editingTripIndex = null;
    dom.editTripModal.classList.remove('open');
    dom.editTripModal.hidden = true;
  }

  async function handleSaveEditedTrip() {
    if (editingTripIndex === null) return;

    const trip = trips[editingTripIndex];
    if (!trip) return;

    const nextName = dom.editTripNameInput.value.trim();
    if (!nextName) return;

    setSaveEditTripLoading(true);

    try {
      Object.assign(trip, normalizeTripRecord({
        ...trip,
        name: nextName,
        month: dom.editTripMonthInput.value,
        status: dom.editTripStatusInput.value
      }));

      await persistAppData('Viagem editada em data/app-data.json');
      setSaveEditTripLoading(false);
      closeEditTripModal();
      updateTripMode();
      renderTrips();
      renderVisitedCitiesList();
      void refreshVisitedCountriesLayer();
    } finally {
      setSaveEditTripLoading(false);
    }
  }

  function syncCitiesFromSelectedTrip() {
    if (selectedTripIndex === null) return;

    const trip = trips[selectedTripIndex];
    if (!trip) return;

    cities.length = 0;
    trip.cities.forEach((city) => cities.push(normalizeCity(city)));
  }

  async function refreshVisitedCountriesLayer() {
    const refreshToken = ++mapOverlayRefreshToken;
    mapOverlayLoadCount += 1;
    syncMapOverlayLoading();

    try {
      if (!visitedOverlayEnabled) {
        if (!isLatestMapOverlayRefresh(refreshToken)) {
          return;
        }
        clearVisitedOverlayLayer();
        setVisitedOverlayStatus('Camada desligada');
        return;
      }

      if (visitedOverlayMode === 'region') {
        await refreshVisitedRegionsLayer(refreshToken);
        return;
      }

      await refreshVisitedCountryLayer(refreshToken);
    } finally {
      mapOverlayLoadCount = Math.max(0, mapOverlayLoadCount - 1);
      syncMapOverlayLoading();
    }
  }

  async function refreshVisitedCountryLayer(refreshToken = mapOverlayRefreshToken) {
    const countryOverlayTargets = getCountryOverlayTargets();
    if (!countryOverlayTargets.totalPoints) {
      if (!isLatestMapOverlayRefresh(refreshToken)) {
        return;
      }
      clearVisitedOverlayLayer();
      setVisitedOverlayStatus('Nenhum pais identificado nas viagens ainda');
      return;
    }

    setVisitedOverlayStatus('Carregando paises...');
    const geoJson = await loadWorldGeoJson();
    if (!isLatestMapOverlayRefresh(refreshToken)) {
      return;
    }

    if (!geoJson) {
      setVisitedOverlayStatus('Nao foi possivel carregar os contornos dos paises');
      return;
    }

    const geoJsonFeatures = Array.isArray(geoJson.features) ? geoJson.features : [];
    const statusByFeatureKey = buildCountryOverlayStatusByKey(geoJsonFeatures, countryOverlayTargets);
    if (!statusByFeatureKey.size) {
      clearVisitedOverlayLayer();
      setVisitedOverlayStatus('Nenhum poligono encontrado para os pontos das viagens');
      return;
    }

    const matchedCounts = {
      visited: 0,
      planned: 0,
      selected: 0
    };
    statusByFeatureKey.forEach((status) => {
      matchedCounts[status] += 1;
    });

    const matchedFeatures = [];
    geoJsonFeatures.forEach((feature, index) => {
      const status = statusByFeatureKey.get(getOverlayFeatureKey(feature, index));
      if (!status) {
        return;
      }

      matchedFeatures.push({
        ...feature,
        properties: {
          ...(feature.properties || {}),
          __overlayStatus: status
        }
      });
    });

    if (!isLatestMapOverlayRefresh(refreshToken)) {
      return;
    }

    clearVisitedOverlayLayer();
    visitedCountriesLayer = L.geoJSON({
      type: 'FeatureCollection',
      features: matchedFeatures
    }, {
      style: (feature) => getVisitedOverlayStyle(feature?.properties?.__overlayStatus),
      interactive: false
    }).addTo(map);

    setVisitedOverlayStatus(`${statusByFeatureKey.size} pais(es) destacados no mapa (${formatOverlayCountSummary(matchedCounts)})`);
  }

  async function refreshVisitedRegionsLayer(refreshToken = mapOverlayRefreshToken) {
    const regionOverlayTargets = getRegionOverlayTargets();
    if (!regionOverlayTargets.totalCount) {
      if (!isLatestMapOverlayRefresh(refreshToken)) {
        return;
      }
      clearVisitedOverlayLayer();
      setVisitedOverlayStatus('Nenhuma região identificada nas viagens ainda');
      return;
    }

    setVisitedOverlayStatus(`Carregando ${regionOverlayTargets.totalCount} região(ões)...`);

    const matchedCounts = {
      visited: 0,
      planned: 0,
      selected: 0
    };
    const matchedFeatures = [];

    for (const [regionKey, entry] of regionOverlayTargets.entries) {
      const feature = await loadRegionFeatureForEntry(entry);
      if (!isLatestMapOverlayRefresh(refreshToken)) {
        return;
      }
      if (!feature?.geometry) {
        continue;
      }

      const status = regionOverlayTargets.statusByKey.get(regionKey) || 'visited';
      matchedCounts[status] += 1;
      matchedFeatures.push({
        ...feature,
        properties: {
          ...(feature.properties || {}),
          __overlayStatus: status
        }
      });
    }

    if (!isLatestMapOverlayRefresh(refreshToken)) {
      return;
    }

    clearVisitedOverlayLayer();

    if (!matchedFeatures.length) {
      setVisitedOverlayStatus('Não foi possível identificar regiões visitadas com os contornos disponíveis');
      return;
    }

    visitedCountriesLayer = L.geoJSON({
      type: 'FeatureCollection',
      features: matchedFeatures
    }, {
      style: (feature) => getVisitedOverlayStyle(feature?.properties?.__overlayStatus),
      interactive: false
    }).addTo(map);

    setVisitedOverlayStatus(`${matchedFeatures.length} região(ões) destacada(s) no mapa (${formatOverlayCountSummary(matchedCounts)})`);
  }

  function getCountryOverlayTargets() {
    const completedCities = getOverlayCitiesForTrips(trips.filter((trip) => trip.status === 'completed'));
    const plannedCities = getOverlayCitiesForTrips(trips.filter((trip) => trip.status === 'planned'));
    const selectedTrip = getSelectedTrip();
    const selectedCities = selectedTrip ? getOverlayCitiesForTrips([selectedTrip]) : [];

    return {
      completedCities,
      plannedCities,
      selectedCities,
      totalPoints: completedCities.length + plannedCities.length + selectedCities.length
    };
  }

  function getOverlayCitiesForTrips(sourceTrips) {
    const uniqueCities = new Map();

    sourceTrips.forEach((trip) => {
      (trip?.cities || []).forEach((city) => {
        if (!Number.isFinite(city?.lat) || !Number.isFinite(city?.lng)) {
          return;
        }

        uniqueCities.set(`${Number(city.lat).toFixed(4)},${Number(city.lng).toFixed(4)}`, city);
      });
    });

    return [...uniqueCities.values()];
  }

  function buildCountryOverlayStatusByKey(features, targets) {
    const statusByFeatureKey = new Map();

    const applyCities = (sourceCities, status) => {
      sourceCities.forEach((city) => {
        const featureKey = resolveCountryFeatureKeyForCity(city, features);
        if (!featureKey) {
          return;
        }

        const currentStatus = statusByFeatureKey.get(featureKey);
        if (getOverlayStatusPriority(status) >= getOverlayStatusPriority(currentStatus)) {
          statusByFeatureKey.set(featureKey, status);
        }
      });
    };

    applyCities(targets.plannedCities, 'planned');
    applyCities(targets.completedCities, 'visited');
    applyCities(targets.selectedCities, 'selected');

    return statusByFeatureKey;
  }

  function resolveCountryFeatureKeyForCity(city, features) {
    if (!Number.isFinite(city?.lat) || !Number.isFinite(city?.lng)) {
      return null;
    }

    const cacheKey = `${Number(city.lat).toFixed(4)},${Number(city.lng).toFixed(4)}`;
    if (countryFeatureMatchCache.has(cacheKey)) {
      return countryFeatureMatchCache.get(cacheKey);
    }

    let matchedFeatureKey = null;
    for (let index = 0; index < features.length; index += 1) {
      if (pointInFeature(city.lat, city.lng, features[index])) {
        matchedFeatureKey = getOverlayFeatureKey(features[index], index);
        break;
      }
    }

    countryFeatureMatchCache.set(cacheKey, matchedFeatureKey);
    return matchedFeatureKey;
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
        return geoJson;
      } catch {
        continue;
      }
    }

    return null;
  }

  function clearVisitedOverlayLayer() {
    if (!visitedCountriesLayer) {
      return;
    }

    map.removeLayer(visitedCountriesLayer);
    visitedCountriesLayer = null;
  }

  function getVisitedOverlayStyle(status = 'visited') {
    const palette = status === 'selected'
      ? {
        color: '#be123c',
        fillColor: '#fb7185',
        weight: 2.2,
        opacity: 0.88,
        fillOpacity: 0.38
      }
      : status === 'planned'
        ? {
          color: '#ca8a04',
          fillColor: '#facc15',
          weight: 1.5,
          opacity: 0.75,
          fillOpacity: 0.3
        }
        : {
          color: '#0f766e',
          fillColor: '#14b8a6',
          weight: 1,
          opacity: 0.55,
          fillOpacity: 0.35
        };

    return {
      color: palette.color,
      weight: palette.weight,
      opacity: palette.opacity,
      lineJoin: 'round',
      fillColor: palette.fillColor,
      fillOpacity: palette.fillOpacity
    };
  }

  function getSelectedTrip() {
    if (selectedTripIndex === null) {
      return null;
    }

    return trips[selectedTripIndex] || null;
  }

  function getRegionOverlayTargets() {
    const entries = new Map();
    const statusByKey = new Map();

    const applyEntries = (tripEntries, status) => {
      tripEntries.forEach((entry, key) => {
        entries.set(key, entry);
        const currentStatus = statusByKey.get(key);
        if (getOverlayStatusPriority(status) >= getOverlayStatusPriority(currentStatus)) {
          statusByKey.set(key, status);
        }
      });
    };

    applyEntries(getRegionEntriesForTrips(trips.filter((trip) => trip.status === 'planned')), 'planned');
    applyEntries(getRegionEntriesForTrips(trips.filter((trip) => trip.status === 'completed')), 'visited');

    const selectedTrip = getSelectedTrip();
    if (selectedTrip) {
      applyEntries(getRegionEntriesForTrips([selectedTrip]), 'selected');
    }

    return {
      entries,
      statusByKey,
      totalCount: entries.size
    };
  }

  function getOverlayStatusPriority(status) {
    if (status === 'selected') {
      return 3;
    }

    if (status === 'visited') {
      return 2;
    }

    if (status === 'planned') {
      return 1;
    }

    return 0;
  }

  function getRegionEntriesForTrips(sourceTrips) {
    const tripCities = sourceTrips
      .flatMap((trip) => trip.cities || [])
      .filter((city) => Number.isFinite(city?.lat) && Number.isFinite(city?.lng));

    return getRegionEntriesFromCities(tripCities);
  }

  function getRegionEntriesFromCities(sourceCities) {
    const regions = new Map();

    sourceCities.forEach((city) => {
      const regionName = city.regionName?.trim();
      const cityName = city.cityName?.trim();
      const countryName = city.country?.trim();
      const countryCode = city.countryCode ? normalizeOverlayCountryCode(city.countryCode) : '';
      if ((!regionName && !cityName) || !countryName || !countryCode) {
        return;
      }

      const regionKey = normalizeRegionName(regionName || cityName);
      if (!regionKey) {
        return;
      }

      const entryKey = `${countryCode}:${regionKey}`;
      if (!regions.has(entryKey)) {
        regions.set(entryKey, {
          regionName: regionName || null,
          cityName: cityName || null,
          countryName,
          countryCode,
          regionKey
        });
      }
    });

    return regions;
  }

  function formatOverlayCountSummary(counts) {
    const parts = [];

    if (counts.visited) {
      parts.push(`${counts.visited} visitado(s)`);
    }

    if (counts.planned) {
      parts.push(`${counts.planned} planejado(s)`);
    }

    if (counts.selected) {
      parts.push(`${counts.selected} selecionado(s)`);
    }

    return parts.join(', ') || 'sem destaque';
  }

  async function loadRegionFeatureForEntry(entry) {
    if (!entry?.regionKey) {
      return null;
    }

    const cacheKey = `${entry.countryCode}:${entry.regionKey}`;
    if (regionGeoJsonCache.has(cacheKey)) {
      return regionGeoJsonCache.get(cacheKey);
    }

    const url = new URL('/api/region-geometry', window.location.origin);
    if (entry.regionName) {
      url.searchParams.set('region', entry.regionName);
    }
    if (entry.cityName) {
      url.searchParams.set('city', entry.cityName);
    }
    url.searchParams.set('country', entry.countryName);

    const feature = await safeFetchJson(url.toString());
    const normalizedFeature = feature?.geometry ? feature : null;
    regionGeoJsonCache.set(cacheKey, normalizedFeature);
    return normalizedFeature;
  }

  function normalizeRegionName(name) {
    return normalizeCountryName(name)
      .replaceAll('estado de ', '')
      .replaceAll('province of ', '')
      .replaceAll('provincia de ', '')
      .replaceAll('provincia del ', '')
      .replaceAll('region de ', '')
      .replaceAll('regiao de ', '')
      .trim();
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
    let inside = false;

    for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current++) {
      const [currentX, currentY] = ring[current];
      const [previousX, previousY] = ring[previous];
      const intersects =
        ((currentY > point[1]) !== (previousY > point[1])) &&
        (point[0] < ((previousX - currentX) * (point[1] - currentY)) / ((previousY - currentY) || Number.EPSILON) + currentX);

      if (intersects) {
        inside = !inside;
      }
    }

    return inside;
  }

  async function safeFetchJson(url, options) {
    try {
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
    } catch {
      return null;
    }
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

      wrapper.querySelector('.country-toggle').onclick = () => {
        const isCurrentlyOpen = wrapper.querySelector('.country-cities')?.classList.contains('open');
        const nextCollapsed = isCurrentlyOpen;
        Object.keys(collapsedCountries).forEach((key) => {
          collapsedCountries[key] = key === countryGroup.key ? nextCollapsed : true;
        });
        if (!(countryGroup.key in collapsedCountries)) {
          collapsedCountries[countryGroup.key] = nextCollapsed;
        }

        dom.cityListEl.querySelectorAll('.country-group').forEach((groupEl) => {
          const citiesEl = groupEl.querySelector('.country-cities');
          const chevronEl = groupEl.querySelector('.country-toggle-chevron');
          const isCurrentGroup = groupEl === wrapper;
          const shouldOpen = isCurrentGroup && !nextCollapsed;

          citiesEl?.classList.toggle('open', shouldOpen);
          if (chevronEl) {
            chevronEl.textContent = shouldOpen ? '▾' : '▸';
          }
        });

        schedulePersistAppData('Preferencia da lista de cidades salva em data/app-data.json');
      };

      const countryCitiesEl = wrapper.querySelector('.country-cities');

      countryGroup.cities.forEach((visitedCity) => {
        const card = document.createElement('article');
        const isRenaming = renamingVisitedCityId === visitedCity.id;
        card.className = 'city-card';
        const flagMarkup = visitedCity.countryCode ? getSingleFlagMarkup(visitedCity.countryCode) : '';
        const ratings = getCityRatings(visitedCity.id);

        card.innerHTML = `
          <div class="city-card-header">
            <div class="city-title">
              <div class="city-name-block">
                <span class="city-name">${escapeHtml(getDisplayVisitedCityName(visitedCity, getCityRatings))}</span>
                <small class="city-country">
                  ${flagMarkup}
                  <span>${escapeHtml(visitedCity.countryLabel)}</span>
                </small>
              </div>
            </div>
            <div class="city-card-actions">
              <button class="city-toggle-btn ${ratings.isCity !== false ? 'active' : ''}" type="button" aria-label="Alternar tipo de local" title="${ratings.isCity !== false ? 'Cidade visitavel com categorias' : 'Local com nota geral'}">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M4 18V10L8.5 7L12 10V18Z" />
                  <path d="M12 18V6L16 3L20 6V18Z" />
                  <path d="M8 12H9.5" />
                  <path d="M14.5 8H17.5" />
                  <path d="M14.5 11H17.5" />
                  <path d="M14.5 14H17.5" />
                </svg>
              </button>
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
          <div class="city-rename ${isRenaming ? 'open' : ''}">
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
          renamingVisitedCityId = visitedCity.id;
          renderVisitedCitiesList();
        };

        if (isRenaming) {
          queueMicrotask(() => {
            card.querySelector('.rename-city-input')?.focus();
          });
        }

        card.querySelector('.save-city-name-btn').onclick = async () => {
          const input = card.querySelector('.rename-city-input');
          const customName = input.value.trim();
          const nextRatings = { ...getCityRatings(visitedCity.id) };
          nextRatings.customName = customName;
          cityRatings[visitedCity.id] = normalizeRatings(nextRatings);
          renamingVisitedCityId = null;
          renderVisitedCitiesList();
          schedulePersistAppData('Nome personalizado salvo em data/app-data.json');
        };

        card.querySelector('.cancel-city-name-btn').onclick = () => {
          renamingVisitedCityId = null;
          renderVisitedCitiesList();
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

          const displayName = getResolvedVisitedCityName(city, index);
          const match = findMatchingVisitedCityGroup(groups, city, displayName);
          if (match) {
            match.points.push(city);
            match.tripNames.add(trip.name);
            match.count += 1;
            upgradeVisitedCityGroupLocation(match, city);
            return;
          }

          groups.push({
            id: createVisitedCityId(city),
            cityName: displayName,
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

  function getResolvedVisitedCityName(city, index) {
    const ratings = getCityRatings(city);
    return ratings.customName?.trim() || getDisplayCityName(city, index);
  }

  function findMatchingVisitedCityGroup(groups, city, displayName) {
    const cityName = normalizeTripCityLabel(displayName || city.cityName || '');
    const countryCode = city.countryCode?.toLowerCase() || '';

    return groups.find((group) => {
      const sameCountry = !countryCode || !group.countryCode || group.countryCode?.toLowerCase() === countryCode;
      if (!sameCountry) return false;

      const groupName = normalizeTripCityLabel(group.cityName || '');
      const distance = distanceBetweenPointsKm(group.lat, group.lng, city.lat, city.lng);

      if (groupName && cityName && groupName === cityName && distance <= CITY_PROXIMITY_KM * 2) {
        return true;
      }

      if (groupName && cityName) {
        return areSimilarTripCityLabels(groupName, cityName) && distance <= 12;
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

  function getCityRatings(cityOrId) {
    const ratingKey = resolveCityRatingKey(cityOrId);
    return normalizeRatings(ratingKey ? cityRatings[ratingKey] : undefined);
  }

  function getTripAverageRating(trip) {
    const cityScores = (trip.cities || [])
      .map((city) => {
        const ratings = getCityRatings(city);
        if (ratings.isCity === false) {
          return 0;
        }

        return getCityScore(city);
      })
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

      return `
        <li class="trip-city-item">
          <span class="trip-city-name">${escapeHtml(citySummary.label)}</span>
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

  function buildTripCitySummaries(trip) {
    const summaries = [];

    (trip.cities || []).forEach((city, index) => {
      const ratings = getCityRatings(city);
      if (ratings.isCity === false) {
        return;
      }
      const customName = ratings.customName?.trim();
      const baseLabel = customName || getDisplayCityName(city, index);
      const normalizedLabel = normalizeTripCityLabel(baseLabel);
      const countryCode = city.countryCode?.toLowerCase() || '';
      const score = getCityScore(city);

      const existing = summaries.find((summary) => {
        const sameCountry =
          !summary.countryCode ||
          !countryCode ||
          summary.countryCode === countryCode;

        if (!sameCountry) {
          return false;
        }

        if (summary.normalizedLabel && normalizedLabel) {
          if (summary.normalizedLabel === normalizedLabel) {
            return true;
          }

          const distance = distanceBetweenPointsKm(summary.lat, summary.lng, city.lat, city.lng);
          return areSimilarTripCityLabels(summary.normalizedLabel, normalizedLabel) && distance <= 12;
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
          existing.normalizedLabel = normalizeTripCityLabel(customName);
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

  function areSimilarTripCityLabels(leftLabel, rightLabel) {
    if (!leftLabel || !rightLabel) {
      return false;
    }

    if (leftLabel === rightLabel) {
      return true;
    }

    if (leftLabel.includes(rightLabel) || rightLabel.includes(leftLabel)) {
      return true;
    }

    const leftTokens = leftLabel.split(' ').filter((token) => token.length > 2);
    const rightTokens = rightLabel.split(' ').filter((token) => token.length > 2);

    if (!leftTokens.length || !rightTokens.length) {
      return false;
    }

    const sharedTokens = leftTokens.filter((token) => rightTokens.includes(token));
    return sharedTokens.length >= Math.min(leftTokens.length, rightTokens.length);
  }

  function normalizeTripCityLabel(label) {
    return normalizeCountryName(label)
      .replaceAll('ae', 'a')
      .replaceAll('oe', 'o')
      .replaceAll('ue', 'u')
      .replaceAll('ss', 's');
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

  function getCityScore(cityOrId) {
    const ratings = getCityRatings(cityOrId);

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

  function resolveCityRatingKey(cityOrId) {
    if (!cityOrId) {
      return null;
    }

    if (typeof cityOrId === 'string') {
      if (cityRatings[cityOrId]) {
        return cityOrId;
      }

      const parsed = parseCityRatingKey(cityOrId);
      return parsed ? findClosestCityRatingKey(parsed, 1.2) : null;
    }

    const directKey = createVisitedCityId(cityOrId);
    if (cityRatings[directKey]) {
      return directKey;
    }

    const closestKey = findClosestCityRatingKey({
      countryCode: cityOrId.countryCode?.toLowerCase() || 'xx',
      lat: Number(cityOrId.lat),
      lng: Number(cityOrId.lng)
    }, 1.2);
    if (closestKey) {
      return closestKey;
    }

    return findRelatedCompletedCityRatingKey(cityOrId);
  }

  function findClosestCityRatingKey(target, maxDistanceKm = 25) {
    if (!Number.isFinite(target?.lat) || !Number.isFinite(target?.lng)) {
      return null;
    }

    let bestKey = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    Object.keys(cityRatings).forEach((key) => {
      const parsed = parseCityRatingKey(key);
      if (!parsed) {
        return;
      }

      const sameCountry =
        parsed.countryCode === target.countryCode ||
        parsed.countryCode === 'xx' ||
        target.countryCode === 'xx';

      if (!sameCountry) {
        return;
      }

      const distance = distanceBetweenPointsKm(target.lat, target.lng, parsed.lat, parsed.lng);
      if (distance <= maxDistanceKm && distance < bestDistance) {
        bestDistance = distance;
        bestKey = key;
      }
    });

    return bestKey;
  }

  function findRelatedCompletedCityRatingKey(targetCity, maxDistanceKm = CITY_PROXIMITY_KM) {
    if (!Number.isFinite(targetCity?.lat) || !Number.isFinite(targetCity?.lng)) {
      return null;
    }

    const targetLabel = normalizeTripCityLabel(getDisplayCityName(targetCity));
    if (!targetLabel) {
      return null;
    }

    const targetCountryCode = targetCity.countryCode?.toLowerCase() || 'xx';
    let bestKey = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestLabelStrength = -1;

    trips
      .filter((trip) => trip.status === 'completed')
      .forEach((trip) => {
        (trip.cities || []).forEach((city, index) => {
          const candidateKey = createVisitedCityId(city);
          if (!cityRatings[candidateKey]) {
            return;
          }

          const candidateCountryCode = city.countryCode?.toLowerCase() || 'xx';
          const sameCountry =
            candidateCountryCode === targetCountryCode ||
            candidateCountryCode === 'xx' ||
            targetCountryCode === 'xx';

          if (!sameCountry) {
            return;
          }

          const distance = distanceBetweenPointsKm(targetCity.lat, targetCity.lng, city.lat, city.lng);
          if (distance > maxDistanceKm) {
            return;
          }

          const customLabel = normalizeTripCityLabel(cityRatings[candidateKey]?.customName || '');
          const defaultLabel = normalizeTripCityLabel(getDisplayCityName(city, index));
          const isExactMatch = customLabel === targetLabel || defaultLabel === targetLabel;
          const isSimilarMatch = !isExactMatch && (
            areSimilarTripCityLabels(customLabel, targetLabel) ||
            areSimilarTripCityLabels(defaultLabel, targetLabel)
          );

          if (!isExactMatch && !isSimilarMatch) {
            return;
          }

          const labelStrength = isExactMatch ? 2 : 1;
          if (
            labelStrength > bestLabelStrength ||
            (labelStrength === bestLabelStrength && distance < bestDistance)
          ) {
            bestKey = candidateKey;
            bestDistance = distance;
            bestLabelStrength = labelStrength;
          }
        });
      });

    return bestKey;
  }

  function parseCityRatingKey(key) {
    const match = String(key).match(/^([a-z]{2,3}):coords:(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?)$/i);
    if (!match) {
      return null;
    }

    return {
      countryCode: match[1].toLowerCase(),
      lat: Number(match[2]),
      lng: Number(match[3])
    };
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
    dom.visitedOverlayToggleBtn.title = visitedOverlayMode === 'region'
      ? 'Visualizar regioes visitadas'
      : 'Visualizar paises visitados';
    dom.visitedOverlayModeToggleBtn.disabled = !visitedOverlayEnabled;
    dom.visitedOverlayModeToggleBtn.classList.toggle('is-subitem-disabled', !visitedOverlayEnabled);
  }

  function syncVisitedOverlayModeButton() {
    const showingRegions = visitedOverlayMode === 'region';
    dom.visitedOverlayModeToggleBtn.classList.toggle('active', showingRegions);
    dom.visitedOverlayModeToggleBtn.setAttribute('aria-pressed', String(showingRegions));
    dom.visitedOverlayModeToggleBtn.querySelector('.overlay-pill-label').textContent = showingRegions ? 'Regiões' : 'Países';
    dom.visitedOverlayModeToggleBtn.querySelector('.overlay-pill-icon').innerHTML = getOverlayModeIconMarkup(showingRegions);
    dom.visitedOverlayModeToggleBtn.title = showingRegions
      ? 'Visualização por regiões, como São Paulo'
      : 'Visualização por países, como Brasil';
  }

  function getOverlayModeIconMarkup(showingRegions) {
    if (showingRegions) {
      return `
        <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
          <path fill="currentColor" d="M8 1.5a4 4 0 0 0-4 4c0 3 4 8.5 4 8.5s4-5.5 4-8.5a4 4 0 0 0-4-4Zm0 5.6a1.6 1.6 0 1 1 0-3.2 1.6 1.6 0 0 1 0 3.2Z"/>
        </svg>
      `;
    }

    return `
      <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/>
        <path d="M3.5 4.5h9v7h-9z" fill="currentColor" opacity="0.14"/>
        <path d="M4.4 8 8 5.2 11.6 8 8 10.8Z" fill="currentColor"/>
        <circle cx="8" cy="8" r="1.2" fill="white"/>
      </svg>
    `;
  }

  function setTripEditorCollapsed(collapsed) {
    tripEditorCollapsed = collapsed;
    dom.tripEditorToggleBtn.setAttribute('aria-expanded', String(!collapsed));
    dom.tripEditorBodyEl.classList.toggle('open', !collapsed);
    dom.tripEditorChevronEl.textContent = collapsed ? '▸' : '▾';
  }

  function applyTheme() {
    const isDark = theme === 'dark';
    document.body.dataset.theme = isDark ? 'dark' : 'light';
    dom.themeToggleBtn.classList.toggle('active', isDark);
    dom.themeToggleBtn.setAttribute('aria-pressed', String(isDark));
    dom.themeToggleBtn.querySelector('.overlay-pill-label').textContent = isDark ? 'Dia' : 'Noite';
    if (isDark) {
      if (map.hasLayer(lightTileLayer)) {
        map.removeLayer(lightTileLayer);
      }
      if (!map.hasLayer(darkTileLayer)) {
        darkTileLayer.addTo(map);
      }
    } else {
      if (map.hasLayer(darkTileLayer)) {
        map.removeLayer(darkTileLayer);
      }
      if (!map.hasLayer(lightTileLayer)) {
        lightTileLayer.addTo(map);
      }
    }
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

  function getOverlayFeatureKey(feature, fallbackIndex = null) {
    return getFeatureCountryCode(feature) || getFeatureCountryName(feature) || (
      fallbackIndex === null ? null : `feature-${fallbackIndex}`
    );
  }

  function isLatestMapOverlayRefresh(refreshToken) {
    return refreshToken === mapOverlayRefreshToken;
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
    syncVisitedOverlayModeButton();
  }

  function syncAppDataStatus(message) {
    dom.appDataStatusEl.textContent = message;
  }

  function syncMapOverlayLoading() {
    dom.mapLoadingOverlayEl.classList.toggle('active', mapOverlayLoadCount > 0);
  }

  function migrateLegacyCityRatings() {
    let changed = false;
    const completedCities = trips
      .filter((trip) => trip.status === 'completed')
      .flatMap((trip) => trip.cities || []);

    Object.entries({ ...cityRatings }).forEach(([legacyKey, ratings]) => {
      if (cityRatings[legacyKey] == null || isCurrentCityRatingKey(legacyKey)) {
        return;
      }

      const migratedKey = findMigratedCityRatingKey(legacyKey, ratings, completedCities);
      if (!migratedKey || migratedKey === legacyKey) {
        return;
      }

      if (!cityRatings[migratedKey]) {
        cityRatings[migratedKey] = normalizeRatings(ratings);
      }

      delete cityRatings[legacyKey];
      changed = true;
    });

    return changed;
  }

  function findMigratedCityRatingKey(legacyKey, ratings, completedCities) {
    const [countryCodeRaw, suffixRaw = '', latRaw = '', lngRaw = ''] = String(legacyKey).split(':');
    const countryCode = countryCodeRaw?.toLowerCase() || '';
    const customName = normalizeCountryName(ratings?.customName || '');
    const suffix = normalizeCountryName(suffixRaw);
    const latitude = Number(latRaw);
    const longitude = Number(lngRaw);

    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      const coordinateMatch = completedCities.find((city) => {
        const cityCountry = city.countryCode?.toLowerCase() || '';
        if (countryCode && cityCountry !== countryCode) {
          return false;
        }

        return (
          Math.abs(city.lat - latitude) <= 0.11 &&
          Math.abs(city.lng - longitude) <= 0.11
        );
      });

      if (coordinateMatch) {
        return createVisitedCityId(coordinateMatch);
      }
    }

    const matchingCity = completedCities.find((city, index, list) => {
      const cityCountry = city.countryCode?.toLowerCase() || '';
      if (countryCode && cityCountry !== countryCode) {
        return false;
      }

      const cityNames = [
        normalizeCountryName(city.cityName || ''),
        normalizeCountryName(city.regionName || '')
      ].filter(Boolean);

      if (customName && cityNames.includes(customName)) {
        return true;
      }

      if (suffix && suffix !== 'ponto' && cityNames.includes(suffix)) {
        return true;
      }

      if (!customName && (!suffix || suffix === 'ponto')) {
        return list.filter((candidate) => (candidate.countryCode?.toLowerCase() || '') === cityCountry).length === 1;
      }

      return false;
    });

    return matchingCity ? createVisitedCityId(matchingCity) : null;
  }

  function isCurrentCityRatingKey(key) {
    return /:coords:-?\d+(\.\d+)?:-?\d+(\.\d+)?$/.test(String(key));
  }

  function snapshotAppData() {
    return createSerializableAppData({
      trips,
      cityRatings,
      collapsedCountries,
      tripSort,
      visitedOverlayEnabled,
      visitedOverlayMode,
      theme
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
    visitedOverlayMode = nextData.preferences.visitedOverlayMode || 'country';
    theme = nextData.preferences.theme || 'light';
    worldGeoJsonCache = null;
    countryFeatureMatchCache.clear();
    locationService.clearCache();
    regionGeoJsonCache.clear();

    dom.tripSortInput.value = tripSort;
    applyTheme();
    syncVisitedOverlayButton();
    syncVisitedOverlayModeButton();
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

  function setSaveEditTripLoading(isLoading) {
    savingEditedTrip = isLoading;
    dom.saveEditTripBtn.disabled = isLoading;
    dom.cancelEditTripBtn.disabled = isLoading;
    dom.closeEditTripModalBtn.disabled = isLoading;
    dom.editTripNameInput.disabled = isLoading;
    dom.editTripMonthInput.disabled = isLoading;
    dom.editTripStatusInput.disabled = isLoading;
    dom.saveEditTripBtn.classList.toggle('is-loading', isLoading);
    dom.saveEditTripBtn.textContent = isLoading ? 'Salvando...' : 'Salvar edição';
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
    tripEditorToggleBtn: document.getElementById('tripEditorToggle'),
    tripEditorToggleLabelEl: document.querySelector('.trip-editor-toggle-label'),
    tripEditorChevronEl: document.getElementById('tripEditorChevron'),
    tripEditorBodyEl: document.getElementById('tripEditorBody'),
    newTripBtn: document.getElementById('newTrip'),
    saveTripBtn: document.getElementById('saveTrip'),
    clearGraphBtn: document.getElementById('clearGraph'),
    visitedOverlayToggleBtn: document.getElementById('visitedOverlayToggle'),
    visitedOverlayModeToggleBtn: document.getElementById('visitedOverlayModeToggle'),
    themeToggleBtn: document.getElementById('themeToggle'),
    visitedOverlayStatusEl: document.getElementById('visitedOverlayStatus'),
    tripsTabBtn: document.getElementById('tripsTabBtn'),
    citiesTabBtn: document.getElementById('citiesTabBtn'),
    tripsTabEl: document.getElementById('tripsTab'),
    citiesTabEl: document.getElementById('citiesTab'),
    importDataBtn: document.getElementById('importDataBtn'),
    exportDataBtn: document.getElementById('exportDataBtn'),
    appDataFileInput: document.getElementById('appDataFileInput'),
    appDataStatusEl: document.getElementById('appDataStatus'),
    mapLoadingOverlayEl: document.getElementById('mapLoadingOverlay'),
    editTripModal: document.getElementById('editTripModal'),
    editTripNameInput: document.getElementById('editTripName'),
    editTripMonthInput: document.getElementById('editTripMonth'),
    editTripStatusInput: document.getElementById('editTripStatus'),
    saveEditTripBtn: document.getElementById('saveEditTrip'),
    cancelEditTripBtn: document.getElementById('cancelEditTrip'),
    closeEditTripModalBtn: document.getElementById('closeEditTripModal')
  };
}

