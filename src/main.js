import { startApp } from './travelApp.js';

startApp().catch((error) => {
  console.error('Falha ao iniciar o app de viagens:', error);

  const sidebar = document.getElementById('sidebar');
  if (!sidebar) {
    return;
  }

  const warning = document.createElement('p');
  warning.className = 'trip-mode';
  warning.textContent = `Nao foi possivel iniciar o app. ${error?.message || 'Veja o console para mais detalhes.'}`;
  sidebar.prepend(warning);

  initializeFallbackUi();
});

function initializeFallbackUi() {
  const tripsTabBtn = document.getElementById('tripsTabBtn');
  const citiesTabBtn = document.getElementById('citiesTabBtn');
  const tripsTabEl = document.getElementById('tripsTab');
  const citiesTabEl = document.getElementById('citiesTab');
  const tripEditorToggle = document.getElementById('tripEditorToggle');
  const tripEditorBody = document.getElementById('tripEditorBody');
  const tripEditorChevron = document.getElementById('tripEditorChevron');
  const newTripBtn = document.getElementById('newTrip');
  const tripList = document.getElementById('tripList');

  if (tripList && !tripList.children.length) {
    tripList.innerHTML = '<li class="city-empty">Adicione uma nova viagem para começar</li>';
  }

  const setActiveTab = (tab) => {
    const showTrips = tab === 'trips';
    tripsTabBtn?.classList.toggle('active', showTrips);
    citiesTabBtn?.classList.toggle('active', !showTrips);
    tripsTabEl?.classList.toggle('active', showTrips);
    citiesTabEl?.classList.toggle('active', !showTrips);
  };

  const openEditor = () => {
    tripEditorBody?.classList.add('open');
    tripEditorToggle?.setAttribute('aria-expanded', 'true');
    if (tripEditorChevron) {
      tripEditorChevron.textContent = '▾';
    }
  };

  tripsTabBtn?.addEventListener('click', () => setActiveTab('trips'));
  citiesTabBtn?.addEventListener('click', () => setActiveTab('cities'));
  tripEditorToggle?.addEventListener('click', () => {
    const isOpen = tripEditorBody?.classList.contains('open');
    tripEditorBody?.classList.toggle('open', !isOpen);
    tripEditorToggle.setAttribute('aria-expanded', String(!isOpen));
    if (tripEditorChevron) {
      tripEditorChevron.textContent = isOpen ? '▸' : '▾';
    }
  });
  newTripBtn?.addEventListener('click', openEditor);

  setActiveTab('trips');
}
