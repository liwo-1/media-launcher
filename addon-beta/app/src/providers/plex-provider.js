'use strict';

const {
  MediaProviderError,
  createLibrary,
  createMediaItem,
  createPlaybackDescriptor,
} = require('../media-model');
const { decodePlexImageRef, encodePlexImageRef } = require('../media-image-ref');
const { joinServerPath, normalizeServerUrl } = require('../server-url');

const PROVIDER = 'plex';
const VALID_PROGRESS_STATES = new Set(['playing', 'paused', 'stopped']);
const METADATA_TIMEOUT_MS = 15000;
const ARTWORK_TIMEOUT_MS = 30000;

function array(value) {
  return Array.isArray(value) ? value : [];
}

function stringId(value) {
  return value === undefined || value === null || value === '' ? null : String(value);
}

function plexLibraryKind(type) {
  if (type === 'movie') return 'movie';
  if (type === 'show') return 'series';
  return null;
}

function plexItemKind(type) {
  if (type === 'movie') return 'movie';
  if (type === 'show') return 'series';
  if (type === 'season') return 'season';
  if (type === 'episode') return 'episode';
  return null;
}

function imageRef(path) {
  if (typeof path !== 'string' || !path) return null;
  try {
    return encodePlexImageRef(path);
  } catch {
    return null;
  }
}

function firstMedia(raw) {
  return array(raw?.Media)[0] || null;
}

function firstPart(raw) {
  return array(firstMedia(raw)?.Part)[0] || null;
}

function firstSourcePath(raw) {
  const file = firstPart(raw)?.file;
  return typeof file === 'string' && file ? file : null;
}

function plexTimestamp(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function plexRatingPercent(value) {
  if (value === undefined || value === null || value === '') return null;
  const rating = Number(value);
  return Number.isFinite(rating) ? Math.max(0, Math.min(100, rating * 10)) : null;
}

function hierarchyFor(raw, kind) {
  if (kind === 'series') {
    return {
      seriesId: stringId(raw.ratingKey),
      seriesTitle: raw.title,
    };
  }
  if (kind === 'season') {
    return {
      seriesId: stringId(raw.parentRatingKey),
      seasonId: stringId(raw.ratingKey),
      seriesTitle: raw.parentTitle,
      seasonTitle: raw.title,
      seasonNumber: raw.index,
    };
  }
  if (kind === 'episode') {
    return {
      seriesId: stringId(raw.grandparentRatingKey),
      seasonId: stringId(raw.parentRatingKey),
      seriesTitle: raw.grandparentTitle,
      seasonTitle: raw.parentTitle,
      seasonNumber: raw.parentIndex,
      episodeNumber: raw.index,
    };
  }
  return {};
}

function normalizePlexLibrary(raw) {
  const kind = plexLibraryKind(raw?.type);
  if (!kind) return null;
  const id = stringId(raw.key);
  if (!id) return null;
  return createLibrary({
    id,
    title: typeof raw.title === 'string' && raw.title ? raw.title : 'Untitled library',
    kind,
    canScan: true,
    provider: PROVIDER,
  });
}

function normalizePlexItem(raw) {
  const kind = plexItemKind(raw?.type);
  const id = stringId(raw?.ratingKey);
  if (!kind || !id) return null;

  const media = firstMedia(raw);
  const posterPath = kind === 'episode'
    ? raw.parentThumb || raw.grandparentThumb || raw.thumb
    : raw.thumb;
  const streams = array(firstPart(raw)?.Stream);
  const audioTracks = streams
    .filter((stream) => Number(stream?.streamType) === 2)
    .map((stream) => ({
      language: stream.language,
      codec: stream.codec,
      channels: stream.channels,
    }));
  const subtitleTracks = streams
    .filter((stream) => Number(stream?.streamType) === 3)
    .map((stream) => ({
      language: stream.language,
      codec: stream.codec,
      forced: stream.forced === true || stream.forced === 1,
    }));

  return createMediaItem({
    id,
    provider: PROVIDER,
    kind,
    title: typeof raw.title === 'string' && raw.title ? raw.title : 'Untitled',
    year: raw.year,
    summary: raw.summary,
    contentRating: raw.contentRating,
    durationMs: raw.duration ?? media?.duration,
    resumePositionMs: raw.viewOffset,
    watched: Number(raw.viewCount) > 0,
    playable: Boolean(firstSourcePath(raw)),
    images: {
      poster: imageRef(posterPath),
      backdrop: imageRef(raw.art),
      thumbnail: imageRef(raw.thumb),
    },
    hierarchy: hierarchyFor(raw, kind),
    counts: {
      children: raw.childCount,
      episodes: raw.leafCount,
      watchedEpisodes: raw.viewedLeafCount,
    },
    genres: array(raw.Genre).map((genre) => genre?.tag).filter(Boolean),
    directors: array(raw.Director).map((director) => director?.tag).filter(Boolean),
    cast: array(raw.Role).map((person) => ({
      name: person?.tag,
      role: person?.role,
      image: imageRef(person?.thumb),
    })),
    ratings: {
      critic: plexRatingPercent(raw.rating),
      audience: plexRatingPercent(raw.audienceRating),
    },
    technical: {
      video: {
        resolution: media?.videoResolution,
        codec: media?.videoCodec,
      },
      audioTracks,
      subtitleTracks,
    },
    addedAt: plexTimestamp(raw.addedAt),
  });
}

function normalizeItems(values) {
  return array(values).map(normalizePlexItem).filter(Boolean);
}

function requireId(value, label) {
  const id = stringId(value);
  if (!id || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id)) {
    throw new MediaProviderError(`${label} is required`, {
      status: 400,
      code: 'invalid_id',
      provider: PROVIDER,
    });
  }
  return id;
}

class PlexProvider {
  #baseUrl;
  #token;
  #fetch;

  constructor({ baseUrl, token, fetchImpl = globalThis.fetch } = {}) {
    if (typeof token !== 'string' || !token) throw new TypeError('Plex token is required');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');

    this.#baseUrl = normalizeServerUrl(baseUrl, { required: true, field: 'Plex baseUrl' });
    this.#token = token;
    this.#fetch = fetchImpl;
    Object.defineProperties(this, {
      kind: { value: PROVIDER, enumerable: true },
      capabilities: {
        value: Object.freeze({
          scanLibrary: true,
          search: true,
          watched: true,
          progress: true,
          related: true,
          directFile: true,
        }),
        enumerable: true,
      },
    });
    Object.freeze(this);
  }

  getConnectionState() {
    return { provider: PROVIDER, configured: true, linked: true };
  }

  async #request(path, {
    responseOnly = false,
    parseJson = true,
    accept = 'application/json',
    timeoutMs = METADATA_TIMEOUT_MS,
  } = {}) {
    let response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    try {
      try {
        response = await this.#fetch(joinServerPath(this.#baseUrl, path), {
          headers: {
            'X-Plex-Token': this.#token,
            Accept: accept,
          },
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (cause) {
        const timedOut = controller.signal.aborted;
        throw new MediaProviderError(
          timedOut ? 'Plex server request timed out.' : 'Plex server could not be reached.',
          {
            status: timedOut ? 504 : 502,
            code: timedOut ? 'provider_timeout' : 'provider_unreachable',
            provider: PROVIDER,
            cause,
          }
        );
      }

      if (Number(response?.status) >= 300 && Number(response?.status) < 400) {
        throw new MediaProviderError('Plex server URL returned a redirect; configure its final URL.', {
          status: 502,
          code: 'provider_redirect_rejected',
          provider: PROVIDER,
        });
      }

      if (!response || typeof response.ok !== 'boolean') {
        throw new MediaProviderError('Plex returned an invalid response.', {
          status: 502,
          code: 'invalid_provider_response',
          provider: PROVIDER,
        });
      }
      if (!response.ok) {
        const upstreamStatus = Number(response.status);
        const status = Number.isInteger(upstreamStatus) && upstreamStatus >= 400 && upstreamStatus <= 599
          ? upstreamStatus
          : 502;
        throw new MediaProviderError(`Plex request failed (${status}).`, {
          status,
          code: 'provider_request_failed',
          provider: PROVIDER,
        });
      }
      if (responseOnly) return response;
      if (!parseJson) return null;

      try {
        return await response.json();
      } catch (cause) {
        if (controller.signal.aborted) {
          throw new MediaProviderError('Plex server request timed out.', {
            status: 504,
            code: 'provider_timeout',
            provider: PROVIDER,
            cause,
          });
        }
        throw new MediaProviderError('Plex returned invalid JSON.', {
          status: 502,
          code: 'invalid_provider_response',
          provider: PROVIDER,
          cause,
        });
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  async #metadata(path) {
    const data = await this.#request(path);
    return data?.MediaContainer || {};
  }

  async #rawItem(itemId) {
    const id = requireId(itemId, 'Media item id');
    const container = await this.#metadata(`/library/metadata/${encodeURIComponent(id)}`);
    const raw = array(container.Metadata)[0];
    if (!raw) {
      throw new MediaProviderError('Plex media item was not found.', {
        status: 404,
        code: 'item_not_found',
        provider: PROVIDER,
      });
    }
    return raw;
  }

  async listLibraries() {
    const container = await this.#metadata('/library/sections');
    return array(container.Directory).map(normalizePlexLibrary).filter(Boolean);
  }

  async listLibraryPaths() {
    const container = await this.#metadata('/library/sections');
    const paths = [];
    for (const raw of array(container.Directory)) {
      const library = normalizePlexLibrary(raw);
      if (!library) continue;
      for (const location of array(raw.Location)) {
        if (typeof location?.path !== 'string' || !location.path) continue;
        paths.push({ path: location.path, library: library.title, libraryId: library.id });
      }
    }
    return paths;
  }

  async listItems(libraryId) {
    const id = requireId(libraryId, 'Library id');
    const container = await this.#metadata(`/library/sections/${encodeURIComponent(id)}/all`);
    return normalizeItems(container.Metadata);
  }

  async listRecentlyAdded(libraryId) {
    const id = requireId(libraryId, 'Library id');
    const container = await this.#metadata(
      `/library/sections/${encodeURIComponent(id)}/recentlyAdded`
    );
    return normalizeItems(container.Metadata);
  }

  async listContinueWatching() {
    const container = await this.#metadata('/library/onDeck');
    return normalizeItems(container.Metadata);
  }

  async getItem(itemId) {
    const item = normalizePlexItem(await this.#rawItem(itemId));
    if (!item) {
      throw new MediaProviderError('Plex returned an unsupported media item.', {
        status: 502,
        code: 'unsupported_provider_item',
        provider: PROVIDER,
      });
    }
    return item;
  }

  async #children(itemId) {
    const id = requireId(itemId, 'Media item id');
    const container = await this.#metadata(
      `/library/metadata/${encodeURIComponent(id)}/children`
    );
    return normalizeItems(container.Metadata);
  }

  async getSeasons(showId) {
    return (await this.#children(showId)).filter((item) => item.kind === 'season');
  }

  async getEpisodes(showId, seasonId) {
    const effectiveSeasonId = seasonId === undefined ? showId : seasonId;
    return (await this.#children(effectiveSeasonId)).filter((item) => item.kind === 'episode');
  }

  async getRelated(itemId) {
    const id = requireId(itemId, 'Media item id');
    const container = await this.#metadata(`/library/metadata/${encodeURIComponent(id)}/related`);
    return normalizeItems(array(container.Hub)[0]?.Metadata);
  }

  async search(query) {
    if (typeof query !== 'string') {
      throw new MediaProviderError('Search query must be a string.', {
        status: 400,
        code: 'invalid_search_query',
        provider: PROVIDER,
      });
    }
    const normalized = query.trim();
    if (!normalized) return [];
    if (normalized.length > 256) {
      throw new MediaProviderError('Search query is too long.', {
        status: 400,
        code: 'invalid_search_query',
        provider: PROVIDER,
      });
    }
    const params = new URLSearchParams({ query: normalized });
    const container = await this.#metadata(`/hubs/search?${params}`);
    return normalizeItems(array(container.Hub).flatMap((hub) => array(hub?.Metadata)));
  }

  async resolvePlayback(itemId) {
    const raw = await this.#rawItem(itemId);
    const item = normalizePlexItem(raw);
    const sourcePath = firstSourcePath(raw);
    if (!item || !sourcePath) {
      throw new MediaProviderError('Plex did not return a playable file path for this item.', {
        status: 422,
        code: 'playback_source_unavailable',
        provider: PROVIDER,
      });
    }
    return createPlaybackDescriptor({
      item,
      sourcePath,
      resumePositionMs: item.resumePositionMs,
      context: {
        provider: PROVIDER,
        itemId: item.id,
        kind: item.kind,
        seriesId: item.hierarchy.seriesId,
        seasonId: item.hierarchy.seasonId,
        seasonNumber: item.hierarchy.seasonNumber,
        episodeNumber: item.hierarchy.episodeNumber,
      },
    });
  }

  async getNextPlayable(playback) {
    const context = playback?.context || playback;
    if (!context || context.provider !== PROVIDER || context.kind !== 'episode' || !context.seasonId) {
      return null;
    }
    const episodes = await this.getEpisodes(context.seriesId, context.seasonId);
    const sorted = [...episodes].sort(
      (left, right) => (left.hierarchy.episodeNumber ?? 0) - (right.hierarchy.episodeNumber ?? 0)
    );
    const currentIndex = sorted.findIndex((episode) => episode.id === String(context.itemId));
    if (currentIndex < 0 || currentIndex === sorted.length - 1) return null;
    return this.resolvePlayback(sorted[currentIndex + 1].id);
  }

  async setWatched(itemId, watched) {
    if (typeof watched !== 'boolean') {
      throw new MediaProviderError('watched must be a boolean.', {
        status: 400,
        code: 'invalid_watched_state',
        provider: PROVIDER,
      });
    }
    const id = requireId(itemId, 'Media item id');
    const action = watched ? 'scrobble' : 'unscrobble';
    const params = new URLSearchParams({
      key: id,
      identifier: 'com.plexapp.plugins.library',
    });
    await this.#request(`/:/${action}?${params}`, { parseJson: false });
  }

  async reportProgress(itemId, progress) {
    const id = requireId(itemId, 'Media item id');
    const state = progress?.state;
    const positionMs = Number(progress?.positionMs);
    const durationMs = Number(progress?.durationMs);
    if (
      !VALID_PROGRESS_STATES.has(state) ||
      !Number.isFinite(positionMs) || positionMs < 0 ||
      !Number.isFinite(durationMs) || durationMs < 0
    ) {
      throw new MediaProviderError('Invalid playback progress.', {
        status: 400,
        code: 'invalid_progress',
        provider: PROVIDER,
      });
    }
    const params = new URLSearchParams({
      ratingKey: id,
      key: `/library/metadata/${id}`,
      state,
      time: String(positionMs),
      duration: String(durationMs),
      identifier: 'com.plexapp.plugins.library',
    });
    await this.#request(`/:/timeline?${params}`, { parseJson: false });
  }

  async scanLibrary(libraryId) {
    const id = requireId(libraryId, 'Library id');
    await this.#request(`/library/sections/${encodeURIComponent(id)}/refresh`, { parseJson: false });
  }

  openArtwork(ref) {
    let path;
    try {
      path = decodePlexImageRef(ref);
    } catch (cause) {
      throw new MediaProviderError('Invalid Plex artwork reference.', {
        status: 400,
        code: 'invalid_artwork_ref',
        provider: PROVIDER,
        cause,
      });
    }
    return this.#request(path, {
      responseOnly: true,
      accept: 'image/*',
      timeoutMs: ARTWORK_TIMEOUT_MS,
    });
  }
}

function createPlexProvider(options) {
  return new PlexProvider(options);
}

module.exports = {
  PlexProvider,
  createPlexProvider,
  normalizePlexLibrary,
  normalizePlexItem,
};
