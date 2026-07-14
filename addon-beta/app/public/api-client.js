// Every path below is relative (no leading "/"): the app is reachable both directly at
// http://<ha-host>:8088/ and embedded via Home Assistant's Ingress proxy at a prefixed path like
// /api/hassio_ingress/<token>/. An absolute "/api/..." path resolves against the browser's actual
// origin, which under Ingress is Home Assistant itself, not the add-on - a relative path resolves
// against the current document instead, landing in the right place either way.
const api = {
  _adminPinKey: 'media-launcher-admin-pin',
  _pinPromptPromise: null,

  _getStoredAdminPin() {
    return localStorage.getItem(api._adminPinKey) || '';
  },

  _storeAdminPin(pin) {
    if (pin) localStorage.setItem(api._adminPinKey, pin);
    else localStorage.removeItem(api._adminPinKey);
  },

  async _requestAdminPin() {
    if (api._pinPromptPromise) return api._pinPromptPromise;
    api._pinPromptPromise = new Promise((resolve) => {
      let value = '';
      const dialog = document.createElement('dialog');
      dialog.className = 'target-picker admin-pin-dialog';
      const heading = document.createElement('h2');
      heading.id = `admin-pin-heading-${Date.now()}`;
      heading.textContent = 'Enter admin PIN';
      dialog.setAttribute('aria-labelledby', heading.id);

      const form = document.createElement('form');
      form.method = 'dialog';
      form.className = 'settings-section admin-pin-form';
      const label = document.createElement('label');
      label.textContent = 'Media Launcher PIN';
      const input = document.createElement('input');
      input.type = 'password';
      input.inputMode = 'numeric';
      input.autocomplete = 'current-password';
      input.minLength = 4;
      input.maxLength = 12;
      input.pattern = '[0-9]{4,12}';
      input.required = true;
      label.appendChild(input);

      const buttons = document.createElement('div');
      buttons.className = 'dialog-actions';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'icon-button-wide';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => dialog.close());
      const submit = document.createElement('button');
      submit.type = 'submit';
      submit.className = 'play-button';
      submit.textContent = 'Unlock';
      buttons.append(cancel, submit);
      form.append(label, buttons);
      form.addEventListener('submit', () => { value = input.value; });
      dialog.append(heading, form);
      dialog.addEventListener('close', () => {
        dialog.remove();
        resolve(value);
      }, { once: true });
      document.body.appendChild(dialog);
      dialog.showModal();
      input.focus();
    });
    try {
      return await api._pinPromptPromise;
    } finally {
      api._pinPromptPromise = null;
    }
  },

  async _adminFetch(path, options = {}, allowPrompt = true) {
    const pin = api._getStoredAdminPin();
    const headers = new Headers(options.headers || {});
    if (pin) headers.set('X-Admin-Pin', pin);
    let response = await fetch(path, { ...options, headers });

    if (response.status === 401 && allowPrompt) {
      api._storeAdminPin('');
      const entered = await api._requestAdminPin();
      if (!entered) return response;
      headers.set('X-Admin-Pin', entered);
      response = await fetch(path, { ...options, headers });
      if (response.ok) api._storeAdminPin(entered);
    }
    return response;
  },
  async getLibraries() {
    return api._get('api/libraries');
  },

  async getItems(parentId) {
    const params = new URLSearchParams({ parentId });
    return api._get(`api/items?${params}`);
  },

  async getRecentlyAdded(libraryKey) {
    return api._get(`api/libraries/${libraryKey}/recentlyAdded`);
  },

  async getItem(itemId) {
    return api._get(`api/items/${itemId}`);
  },

  async getSeasons(showId) {
    return api._get(`api/shows/${showId}/seasons`);
  },

  async getEpisodes(showId, seasonId) {
    return api._get(`api/shows/${showId}/seasons/${seasonId}/episodes`);
  },

  async getOnDeck() {
    return api._get('api/ondeck');
  },

  async getRelated(itemId) {
    return api._get(`api/items/${itemId}/related`);
  },

  imageUrl(relativePath) {
    if (!relativePath) return '';
    return `api/image?path=${encodeURIComponent(relativePath)}`;
  },

  async getPlaybackTargets() {
    return api._get('api/playback-targets');
  },

  async play(itemId, targetId = '') {
    const response = await fetch(`api/play/${itemId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(targetId ? { targetId } : {}),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || `Play failed (${response.status})`);
    }
    return body;
  },

  async markWatched(itemId) {
    return api._post(`api/items/${itemId}/watched`);
  },

  async markUnwatched(itemId) {
    return api._post(`api/items/${itemId}/unwatched`);
  },

  async scanLibrary(libraryKey) {
    return api._post(`api/libraries/${libraryKey}/scan`);
  },

  async requestPlexPin() {
    return api._postAdmin('api/plex-auth/pin');
  },

  async checkPlexPin(id) {
    return api._getAdmin(`api/plex-auth/pin/${id}`);
  },

  async unlinkPlex() {
    return api._postAdmin('api/plex-auth/unlink');
  },

  async getSettings() {
    return api._getAdmin('api/settings');
  },

  async getPlexLibraryPaths() {
    return api._getAdmin('api/settings/plex-libraries');
  },

  async pairPlayerAgent() {
    return api._post('api/player-agent/pair');
  },

  async saveSettings(settings) {
    const response = await api._adminFetch('api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || `Request failed (${response.status})`);
    }
    if (settings.newAdminPin) api._storeAdminPin(settings.newAdminPin);
    return body;
  },

  async disableAdminPin() {
    const body = await api._postAdmin('api/settings/admin-pin/disable');
    api._storeAdminPin('');
    return body;
  },

  async removePlayerAgent(agentId) {
    const response = await api._adminFetch(`api/settings/agents/${encodeURIComponent(agentId)}`, {
      method: 'DELETE',
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body;
  },

  async _post(path) {
    const response = await fetch(path, { method: 'POST' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || `Request failed (${response.status})`);
    }
    return body;
  },

  async _get(path) {
    const response = await fetch(path);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || `Request failed (${response.status})`);
    }
    return body;
  },

  async _postAdmin(path) {
    const response = await api._adminFetch(path, { method: 'POST' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body;
  },

  async _getAdmin(path) {
    const response = await api._adminFetch(path);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body;
  },
};
