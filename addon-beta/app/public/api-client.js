// Every path below is relative (no leading "/"): the app is reachable both directly at
// http://<ha-host>:8088/ and embedded via Home Assistant's Ingress proxy at a prefixed path like
// /api/hassio_ingress/<token>/. An absolute "/api/..." path resolves against the browser's actual
// origin, which under Ingress is Home Assistant itself, not the add-on - a relative path resolves
// against the current document instead, landing in the right place either way.
const api = {
  _adminPinKey: 'media-launcher-admin-pin',
  _adminPin: '',
  _legacyAdminPinPurged: false,
  _pinPromptPromise: null,

  _getStoredAdminPin() {
    // Older beta builds persisted the raw PIN in localStorage. Remove that value once, then keep
    // the PIN only for this page lifetime so another same-origin add-on cannot read it later.
    if (!api._legacyAdminPinPurged) {
      try { localStorage.removeItem(api._adminPinKey); } catch {}
      api._legacyAdminPinPurged = true;
    }
    return api._adminPin;
  },

  _storeAdminPin(pin) {
    api._adminPin = typeof pin === 'string' ? pin : '';
    try { localStorage.removeItem(api._adminPinKey); } catch {}
    api._legacyAdminPinPurged = true;
  },

  async _isAdminPinChallenge(response) {
    if (response.status !== 401) return false;
    const body = await response.clone().json().catch(() => ({}));
    return body?.adminPinRequired === true;
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

    if (allowPrompt && await api._isAdminPinChallenge(response)) {
      api._storeAdminPin('');
      const entered = await api._requestAdminPin();
      if (!entered) return response;
      headers.set('X-Admin-Pin', entered);
      response = await fetch(path, { ...options, headers });
      if (response.ok) api._storeAdminPin(entered);
    }
    return response;
  },
  async getBootstrap(signal) {
    return api._get('api/bootstrap', { signal });
  },

  async getLibraries(signal) {
    return api._get('api/media/libraries', { signal });
  },

  async getLibraryItems(libraryId, signal) {
    return api._get(`api/media/libraries/${encodeURIComponent(libraryId)}/items`, { signal });
  },

  async getRecentlyAdded(libraryId, signal) {
    return api._get(
      `api/media/libraries/${encodeURIComponent(libraryId)}/recently-added`,
      { signal }
    );
  },

  async getContinueWatching(signal) {
    return api._get('api/media/continue-watching', { signal });
  },

  async searchMedia(query, signal) {
    const params = new URLSearchParams({ q: String(query || '') });
    return api._get(`api/media/search?${params}`, { signal });
  },

  async getItem(itemId, signal) {
    return api._get(`api/media/items/${encodeURIComponent(itemId)}`, { signal });
  },

  async getRelated(itemId, signal) {
    return api._get(`api/media/items/${encodeURIComponent(itemId)}/related`, { signal });
  },

  async getSeasons(seriesId, signal) {
    return api._get(`api/media/series/${encodeURIComponent(seriesId)}/seasons`, { signal });
  },

  async getEpisodes(seriesId, seasonId, signal) {
    return api._get(
      `api/media/series/${encodeURIComponent(seriesId)}/seasons/${encodeURIComponent(seasonId)}/episodes`,
      { signal }
    );
  },

  imageUrl(opaqueRef) {
    if (!opaqueRef) return '';
    return `api/media/images/${encodeURIComponent(opaqueRef)}`;
  },

  async getPlaybackTargets(signal) {
    return api._get('api/playback-targets', { signal });
  },

  async getPlaybackSessions(signal) {
    return api._get('api/playback-sessions', { signal });
  },

  async play(itemId, targetId = '') {
    const response = await fetch(`api/play/${encodeURIComponent(itemId)}`, {
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

  async controlPlaybackSession(sessionId, { targetId, action, positionMs } = {}) {
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new TypeError('Playback session id is required');
    }
    if (typeof targetId !== 'string' || !targetId) {
      throw new TypeError('Playback target id is required');
    }
    if (!['pause', 'resume', 'seek', 'stop'].includes(action)) {
      throw new TypeError('Unsupported playback control action');
    }
    const payload = { targetId, action };
    if (action === 'seek') {
      if (!Number.isSafeInteger(positionMs) || positionMs < 0) {
        throw new TypeError('Seek position must be a non-negative integer');
      }
      payload.positionMs = positionMs;
    }
    return api._postJson(
      `api/playback-sessions/${encodeURIComponent(sessionId)}/control`,
      payload
    );
  },

  async setWatched(itemId, watched) {
    return api._postJson(
      `api/media/items/${encodeURIComponent(itemId)}/watched`,
      { watched: Boolean(watched) }
    );
  },

  async scanLibrary(libraryId) {
    return api._post(`api/media/libraries/${encodeURIComponent(libraryId)}/scan`);
  },

  async requestPlexPin() {
    const pin = await api._postAdmin('api/plex-auth/pin');
    // The legacy Settings view interpolates this value into its fixed Plex instructions. Keep the
    // browser destination constant rather than trusting a response-provided URL.
    return { ...pin, linkUrl: 'https://plex.tv/link' };
  },

  async checkPlexPin(id) {
    return api._getAdmin(`api/plex-auth/pin/${encodeURIComponent(id)}`);
  },

  async unlinkPlex() {
    return api._postAdmin('api/plex-auth/unlink');
  },

  async loginJellyfin({ serverUrl, username, password }) {
    // Settings was already unlocked by getSettings(). Do not treat Jellyfin's own 401 response as
    // an admin-PIN challenge and resend a user's password after another prompt.
    const response = await api._adminFetch('api/jellyfin-auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverUrl, username, password }),
    }, false);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body;
  },

  async commitJellyfinLogin(linkId) {
    return api._postAdminJson('api/jellyfin-auth/login/commit', { linkId });
  },

  async unlinkJellyfin() {
    return api._postAdmin('api/jellyfin-auth/unlink');
  },

  async getSettings() {
    return api._getAdmin('api/settings');
  },

  async getPlexLibraryPaths() {
    return api._getAdmin('api/settings/plex-libraries');
  },

  async getMediaServerLibraryPaths() {
    return api._getAdmin('api/settings/media-server/library-paths');
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

  async _postJson(path, value) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || `Request failed (${response.status})`);
    }
    return body;
  },

  async _get(path, options = {}) {
    const response = await fetch(path, options);
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

  async _postAdminJson(path, value) {
    const response = await api._adminFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
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

// Run the one-time migration even when normal startup never opens PIN-protected Settings.
api._getStoredAdminPin();
