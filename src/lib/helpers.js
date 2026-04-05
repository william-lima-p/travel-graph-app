const regionNamesInEnglish = typeof Intl !== 'undefined' && Intl.DisplayNames
  ? new Intl.DisplayNames(['en'], { type: 'region' })
  : null;

const regionNamesInPortuguese = typeof Intl !== 'undefined' && Intl.DisplayNames
  ? new Intl.DisplayNames(['pt-BR'], { type: 'region' })
  : null;

export function compareMonthAsc(a, b) {
  const left = a || '9999-99';
  const right = b || '9999-99';
  return left.localeCompare(right);
}

export function compareMonthDesc(a, b) {
  const left = a || '0000-00';
  const right = b || '0000-00';
  return right.localeCompare(left);
}

export function formatTripMonth(monthValue) {
  if (!monthValue) {
    return 'Sem data';
  }

  const [year, month] = monthValue.split('-').map(Number);
  if (!year || !month) {
    return 'Sem data';
  }

  return new Intl.DateTimeFormat('pt-BR', {
    month: 'short',
    year: 'numeric'
  }).format(new Date(year, month - 1, 1));
}

export function getCurrentMonthValue() {
  return new Date().toISOString().slice(0, 7);
}

export function normalizeCountryName(name) {
  return String(name || '')
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .replaceAll(/[^a-zA-Z\s]/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function normalizeOverlayCountryCode(code) {
  const normalized = String(code || '').toUpperCase();

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

export function getCountryLabelFromCode(code) {
  return regionNamesInPortuguese?.of(code) || regionNamesInEnglish?.of(code) || code;
}

export function getCountryEnglishLabelFromCode(code) {
  return regionNamesInEnglish?.of(code) || code;
}

export function getTripCountryCodes(trip) {
  const codes = [];
  const seen = new Set();

  (trip?.cities || []).forEach((city) => {
    const code = city?.countryCode?.toLowerCase();
    if (!code || seen.has(code)) {
      return;
    }

    seen.add(code);
    codes.push(code);
  });

  return codes;
}

export function getFlagMarkup(countryCodes) {
  if (!countryCodes.length) {
    return '<span class="flag-list empty">Sem bandeiras</span>';
  }

  const icons = countryCodes.map((code) => {
    const upperCode = code.toUpperCase();
    const countryLabel = getCountryLabelFromCode(upperCode);
    const primarySrc = `https://flagcdn.com/${code}.svg`;

    return `
      <img
        class="flag-icon"
        src="${primarySrc}"
        alt="Bandeira ${countryLabel}"
        title="${countryLabel}"
        loading="lazy"
        referrerpolicy="no-referrer"
      />
    `;
  }).join('');

  return `<span class="flag-list">${icons}</span>`;
}

export function getSingleFlagMarkup(countryCode) {
  const code = String(countryCode).toLowerCase();
  const upperCode = code.toUpperCase();
  const countryLabel = getCountryLabelFromCode(upperCode);
  const primarySrc = `https://flagcdn.com/${code}.svg`;

  return `
    <img
      class="flag-icon tiny"
      src="${primarySrc}"
      alt="Bandeira ${countryLabel}"
      title="${countryLabel}"
      loading="lazy"
      referrerpolicy="no-referrer"
    />
  `;
}

export function getCountryDisplayLabel(city) {
  if (city?.country) {
    return city.country;
  }

  if (city?.countryCode) {
    const label = getCountryLabelFromCode(city.countryCode.toUpperCase());
    if (label) {
      return label;
    }
  }

  if (city?.regionName) {
    return city.regionName;
  }

  return 'Sem pais identificado';
}

export function getDisplayCityName(city, index) {
  return city?.cityName || city?.regionName || formatCoordinateLabel(city, index);
}

export function formatCoordinateLabel(city, index) {
  if (Number.isFinite(city?.lat) && Number.isFinite(city?.lng)) {
    return `Ponto ${index + 1} (${city.lat.toFixed(2)}, ${city.lng.toFixed(2)})`;
  }

  return `Ponto ${index + 1}`;
}

export function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function totalDistance(list) {
  let total = 0;

  for (let index = 1; index < list.length; index += 1) {
    const previous = list[index - 1];
    const current = list[index];
    total += distanceBetweenPointsKm(previous.lat, previous.lng, current.lat, current.lng);
  }

  return total;
}

export function distanceBetweenPointsKm(latA, lngA, latB, lngB) {
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

export function zoomToCities(map, list) {
  const validPoints = list.filter((city) => Number.isFinite(city.lat) && Number.isFinite(city.lng));
  if (!validPoints.length) {
    return;
  }

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

export function createVisitedCityId(city) {
  const countryCode = normalizeOverlayCountryCode(city?.countryCode || 'xx').toLowerCase();
  return `${countryCode}:coords:${city.lat.toFixed(2)}:${city.lng.toFixed(2)}`;
}

export function renderRatingRow(category, label, currentValue) {
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

export function getDisplayVisitedCityName(visitedCity, getCityRatings) {
  const ratings = getCityRatings(visitedCity.id);
  return ratings.customName?.trim() || visitedCity.cityName;
}


