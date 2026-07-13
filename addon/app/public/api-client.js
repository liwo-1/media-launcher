const api = {
  async getLibraries() {
    return api._get('/api/libraries');
  },

  async getItems(parentId) {
    const params = new URLSearchParams({ parentId });
    return api._get(`/api/items?${params}`);
  },

  async getRecentlyAdded(libraryKey) {
    return api._get(`/api/libraries/${libraryKey}/recentlyAdded`);
  },

  async getItem(itemId) {
    return api._get(`/api/items/${itemId}`);
  },

  async getSeasons(showId) {
    return api._get(`/api/shows/${showId}/seasons`);
  },

  async getEpisodes(showId, seasonId) {
    return api._get(`/api/shows/${showId}/seasons/${seasonId}/episodes`);
  },

  async getOnDeck() {
    return api._get('/api/ondeck');
  },

  async getRelated(itemId) {
    return api._get(`/api/items/${itemId}/related`);
  },

  imageUrl(relativePath) {
    if (!relativePath) return '';
    return `/api/image?path=${encodeURIComponent(relativePath)}`;
  },

  async play(itemId) {
    const response = await fetch(`/api/play/${itemId}`, { method: 'POST' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || `Play failed (${response.status})`);
    }
    return body;
  },

  async markWatched(itemId) {
    return api._post(`/api/items/${itemId}/watched`);
  },

  async markUnwatched(itemId) {
    return api._post(`/api/items/${itemId}/unwatched`);
  },

  async scanLibrary(libraryKey) {
    return api._post(`/api/libraries/${libraryKey}/scan`);
  },

  async getPlexAuthStatus() {
    return api._get('/api/plex-auth/status');
  },

  async requestPlexPin() {
    return api._post('/api/plex-auth/pin');
  },

  async checkPlexPin(id) {
    return api._get(`/api/plex-auth/pin/${id}`);
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
};
