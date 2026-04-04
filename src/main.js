import { startApp } from './travelApp.js';

startApp().catch((error) => {
  console.error('Falha ao iniciar o app de viagens:', error);

  const sidebar = document.getElementById('sidebar');
  if (!sidebar) {
    return;
  }

  const warning = document.createElement('p');
  warning.className = 'trip-mode';
  warning.textContent = 'Nao foi possivel iniciar o app. Veja o console para mais detalhes.';
  sidebar.prepend(warning);
});
