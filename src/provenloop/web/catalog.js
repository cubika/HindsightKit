"use strict";
(async () => {
  try {
    const response = await fetch('/api/connectors', {cache:'no-store'});
    if (!response.ok) throw new Error('Could not load connectors. Refresh to try again.');
    const data = await response.json();
    const root = document.getElementById('connector-list');
    root.replaceChildren();
    for (const connector of data.connectors) {
      const card = document.createElement('section');
      card.className = 'panel connector-card';
      const title = document.createElement('h2');
      title.textContent = connector.title;
      const description = document.createElement('p');
      description.className = 'section-description';
      description.textContent = connector.description;
      const state = document.createElement('p');
      state.className = 'field-help';
      state.textContent = connector.availability.ready ? (connector.enabled ? 'Scheduled sync enabled' : 'Optional · Scheduled sync off') : connector.availability.message;
      const link = document.createElement('a');
      link.className = 'button button-primary';
      link.href = '/connectors/' + encodeURIComponent(connector.id);
      link.textContent = 'Configure';
      card.append(title, description, state, link);
      root.append(card);
    }
  } catch (error) {
    document.getElementById('connector-list').replaceChildren();
    const banner = document.getElementById('catalog-error');
    banner.textContent = 'Could not load connectors. Refresh to try again.';
    banner.hidden = false;
  }
})();
