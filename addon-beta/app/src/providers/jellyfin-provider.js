'use strict';

const {
  MediaProviderError,
  createLibrary,
  createMediaItem,
  createPlaybackDescriptor,
} = require('../media-model');
const { decodeImageRef, encodeImageRef } = require('../media-image-ref');
const { authenticationHeaders } = require('../jellyfin-auth');
const { joinServerPath, normalizeServerUrl } = require('../server-url');

const PROVIDER = 'jellyfin';
const METADATA_TIMEOUT_MS = 15000;
const ARTWORK_TIMEOUT_MS = 30000;
const LIST_LIMIT = 200;
const MAX_LIBRARY_ITEMS = 50000;
const LIBRARY_DEADLINE_MS = 60000;
const FEED_LIMIT = 50;
const RELATED_LIMIT = 25;
const MAX_STARTED_SESSIONS = 1024;
const VALID_PROGRESS_STATES = new Set(['playing', 'paused', 'stopped']);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const IMAGE_TYPES = new Set([
  'Primary',
  'Art',
  'Backdrop',
  'Banner',
  'Logo',
  'Thumb',
  'Disc',
  'Box',
  'Screenshot',
  'Menu',
]);
const IMAGE_NUMBER_PARAMS = new Map([
  ['maxWidth', 4096],
  ['maxHeight', 4096],
  ['width', 4096],
  ['height', 4096],
  ['quality', 100],
]);
const ITEM_FIELDS = 'Overview,Genres,People,MediaSources,MediaStreams';

function array(value) {
  return Array.isArray(value) ? value : [];
}

function stringId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const id = String(value);
  return ID_PATTERN.test(id) ? id : null;
}

function requireId(value, label) {
  const id = stringId(value);
  if (!id) {
    throw new MediaProviderError(`${label} is invalid.`, {
      status: 400,
      code: 'invalid_id',
      provider: PROVIDER,
    });
  }
  return id;
}

function requireAdministrator(isAdministrator) {
  if (!isAdministrator) {
    throw new MediaProviderError('Jellyfin administrator access is required.', {
      status: 403,
      code: 'administrator_required',
      provider: PROVIDER,
    });
  }
}

function jellyfinLibraryKind(value) {
  const type = String(value || '').toLowerCase();
  if (type === 'movies') return 'movie';
  if (type === 'tvshows') return 'series';
  return null;
}

function jellyfinItemKind(value) {
  const type = String(value || '').toLowerCase();
  if (type === 'movie') return 'movie';
  if (type === 'series') return 'series';
  if (type === 'season') return 'season';
  if (type === 'episode') return 'episode';
  return null;
}

function tickMilliseconds(value) {
  const ticks = Number(value);
  return Number.isFinite(ticks) && ticks >= 0 ? ticks / 10000 : 0;
}

function timestamp(value) {
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function ratingPercent(value, multiplier = 1) {
  if (value === undefined || value === null || value === '') return null;
  const rating = Number(value);
  if (!Number.isFinite(rating)) return null;
  return Math.max(0, Math.min(100, rating * multiplier));
}

function firstFileSource(raw) {
  return array(raw?.MediaSources).find((source) => (
    String(source?.Protocol || '').toLowerCase() === 'file' &&
    typeof source?.Path === 'string' &&
    source.Path.length > 0
  )) || null;
}

function validateJellyfinImagePath(path) {
  if (
    typeof path !== 'string' ||
    !path.startsWith('/Items/') ||
    path.includes('\\') ||
    path.includes('#')
  ) {
    throw new TypeError('Jellyfin artwork must use an item image path');
  }

  let parsed;
  let decodedPath;
  try {
    parsed = new URL(path, 'http://jellyfin.invalid');
    decodedPath = decodeURIComponent(parsed.pathname);
  } catch {
    throw new TypeError('Invalid Jellyfin artwork path');
  }
  if (parsed.origin !== 'http://jellyfin.invalid' || decodedPath.includes('\\')) {
    throw new TypeError('Invalid Jellyfin artwork path');
  }
  if (/[^\x20-\x7e]/.test(decodedPath)) {
    throw new TypeError('Invalid Jellyfin artwork path');
  }

  const match = /^\/Items\/([A-Za-z0-9_-]{1,128})\/Images\/([A-Za-z]+)(?:\/(\d{1,3}))?$/.exec(
    decodedPath
  );
  if (!match || !IMAGE_TYPES.has(match[2]) || Number(match[3] || 0) > 99) {
    throw new TypeError('Jellyfin artwork must use an item image route');
  }

  const seen = new Set();
  for (const [key, value] of parsed.searchParams) {
    if (seen.has(key)) throw new TypeError('Duplicate Jellyfin artwork parameter');
    seen.add(key);
    if (key === 'tag') {
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(value)) {
        throw new TypeError('Invalid Jellyfin image tag');
      }
      continue;
    }
    if (key === 'format') {
      if (!/^(?:jpg|jpeg|png|webp|gif)$/i.test(value)) {
        throw new TypeError('Invalid Jellyfin image format');
      }
      continue;
    }
    const maximum = IMAGE_NUMBER_PARAMS.get(key);
    if (!maximum || !/^\d{1,4}$/.test(value) || Number(value) < 1 || Number(value) > maximum) {
      throw new TypeError('Invalid Jellyfin artwork parameter');
    }
  }
  return path;
}

function jellyfinImageRef(itemId, imageType, tag, { index, maxWidth } = {}) {
  const id = stringId(itemId);
  if (
    !id ||
    !IMAGE_TYPES.has(imageType) ||
    typeof tag !== 'string' ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(tag)
  ) {
    return null;
  }
  let path = `/Items/${encodeURIComponent(id)}/Images/${imageType}`;
  if (index !== undefined) {
    if (!Number.isInteger(index) || index < 0 || index > 99) return null;
    path += `/${index}`;
  }
  const params = new URLSearchParams();
  params.set('tag', tag);
  if (maxWidth) params.set('maxWidth', String(maxWidth));
  params.set('quality', '90');
  if ([...params].length) path += `?${params}`;
  try {
    return encodeImageRef(PROVIDER, validateJellyfinImagePath(path));
  } catch {
    return null;
  }
}

function imagesFor(raw, kind) {
  const ownId = stringId(raw?.Id);
  const tags = raw?.ImageTags && typeof raw.ImageTags === 'object' ? raw.ImageTags : {};
  const seriesId = stringId(raw?.SeriesId);
  const seriesTag = typeof raw?.SeriesPrimaryImageTag === 'string'
    ? raw.SeriesPrimaryImageTag
    : '';
  const parentBackdropId = stringId(raw?.ParentBackdropItemId);
  const ownBackdropTag = array(raw?.BackdropImageTags)[0];
  const parentBackdropTag = array(raw?.ParentBackdropImageTags)[0];

  const poster = (kind === 'episode' || kind === 'season') && seriesId && seriesTag
    ? jellyfinImageRef(seriesId, 'Primary', seriesTag, { maxWidth: 480 })
    : jellyfinImageRef(ownId, 'Primary', tags.Primary, { maxWidth: 480 });
  const backdrop = ownBackdropTag
    ? jellyfinImageRef(ownId, 'Backdrop', ownBackdropTag, { index: 0, maxWidth: 1280 })
    : jellyfinImageRef(
      parentBackdropId,
      'Backdrop',
      parentBackdropTag,
      { index: 0, maxWidth: 1280 }
    );
  const thumbnail = tags.Thumb
    ? jellyfinImageRef(ownId, 'Thumb', tags.Thumb, { maxWidth: 640 })
    : jellyfinImageRef(ownId, 'Primary', tags.Primary, { maxWidth: 640 }) || poster;
  return { poster, backdrop, thumbnail };
}

function hierarchyFor(raw, kind) {
  if (kind === 'series') {
    return {
      seriesId: stringId(raw.Id),
      seriesTitle: raw.Name,
    };
  }
  if (kind === 'season') {
    return {
      seriesId: stringId(raw.SeriesId),
      seasonId: stringId(raw.Id),
      seriesTitle: raw.SeriesName,
      seasonTitle: raw.Name,
      seasonNumber: raw.IndexNumber,
    };
  }
  if (kind === 'episode') {
    return {
      seriesId: stringId(raw.SeriesId),
      seasonId: stringId(raw.SeasonId),
      seriesTitle: raw.SeriesName,
      seasonTitle: raw.SeasonName,
      seasonNumber: raw.ParentIndexNumber,
      episodeNumber: raw.IndexNumber,
    };
  }
  return {};
}

function normalizeJellyfinLibrary(raw, { canScan = false } = {}) {
  const kind = jellyfinLibraryKind(raw?.CollectionType);
  const id = stringId(raw?.Id || raw?.ItemId);
  if (!kind || !id) return null;
  return createLibrary({
    id,
    title: typeof raw.Name === 'string' && raw.Name ? raw.Name : 'Untitled library',
    kind,
    canScan,
    provider: PROVIDER,
  });
}

function streamLanguage(stream) {
  if (typeof stream?.Language === 'string' && stream.Language) return stream.Language;
  return typeof stream?.DisplayLanguage === 'string' ? stream.DisplayLanguage : null;
}

function normalizeJellyfinItem(raw) {
  const kind = jellyfinItemKind(raw?.Type);
  const id = stringId(raw?.Id);
  if (!kind || !id) return null;

  const source = firstFileSource(raw) || array(raw?.MediaSources)[0] || null;
  const streams = array(source?.MediaStreams).length
    ? array(source.MediaStreams)
    : array(raw?.MediaStreams);
  const video = streams.find((stream) => String(stream?.Type).toLowerCase() === 'video') || {};
  const audioTracks = streams
    .filter((stream) => String(stream?.Type).toLowerCase() === 'audio')
    .map((stream) => ({
      language: streamLanguage(stream),
      codec: stream.Codec,
      channels: stream.Channels,
    }));
  const subtitleTracks = streams
    .filter((stream) => String(stream?.Type).toLowerCase() === 'subtitle')
    .map((stream) => ({
      language: streamLanguage(stream),
      codec: stream.Codec,
      forced: stream.IsForced === true,
    }));
  const people = array(raw?.People);
  const episodes = Number(raw?.EpisodeCount ?? raw?.RecursiveItemCount ?? raw?.ChildCount);
  const unplayed = Number(raw?.UserData?.UnplayedItemCount);
  const watchedEpisodes = Number.isFinite(episodes) && episodes >= 0 &&
    Number.isFinite(unplayed) && unplayed >= 0
    ? Math.max(0, episodes - unplayed)
    : 0;

  return createMediaItem({
    id,
    provider: PROVIDER,
    kind,
    title: typeof raw.Name === 'string' && raw.Name ? raw.Name : 'Untitled',
    year: raw.ProductionYear,
    summary: raw.Overview,
    contentRating: raw.OfficialRating,
    durationMs: tickMilliseconds(raw.RunTimeTicks),
    resumePositionMs: tickMilliseconds(raw.UserData?.PlaybackPositionTicks),
    watched: raw.UserData?.Played === true,
    playable: Boolean(firstFileSource(raw)) && (kind === 'movie' || kind === 'episode'),
    images: imagesFor(raw, kind),
    hierarchy: hierarchyFor(raw, kind),
    counts: {
      children: raw.ChildCount,
      episodes,
      watchedEpisodes,
    },
    genres: array(raw.Genres).filter((genre) => typeof genre === 'string' && genre),
    directors: people
      .filter((person) => String(person?.Type).toLowerCase() === 'director')
      .map((person) => person?.Name)
      .filter(Boolean),
    cast: people
      .filter((person) => ['actor', 'gueststar'].includes(String(person?.Type).toLowerCase()))
      .map((person) => ({
        name: person?.Name,
        role: person?.Role,
        image: jellyfinImageRef(person?.Id, 'Primary', person?.PrimaryImageTag, { maxWidth: 256 }),
      })),
    ratings: {
      critic: ratingPercent(raw.CriticRating),
      audience: ratingPercent(raw.CommunityRating, 10),
    },
    technical: {
      video: {
        resolution: Number.isFinite(Number(video.Height)) && Number(video.Height) > 0
          ? String(video.Height)
          : null,
        codec: video.Codec,
      },
      audioTracks,
      subtitleTracks,
    },
    addedAt: timestamp(raw.DateCreated),
  });
}

function normalizeItems(values) {
  return array(values).map(normalizeJellyfinItem).filter(Boolean);
}

function queryPath(path, values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function itemQuery(userId, overrides = {}) {
  return {
    userId,
    fields: ITEM_FIELDS,
    enableUserData: true,
    enableImages: true,
    imageTypeLimit: 1,
    ...overrides,
  };
}

function progressTicks(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
  const ticks = Math.round(milliseconds * 10000);
  return Number.isSafeInteger(ticks) ? ticks : null;
}

class JellyfinProvider {
  #baseUrl;
  #accessToken;
  #userId;
  #deviceId;
  #isAdministrator;
  #fetch;
  #now;
  #startedSessions = new Set();

  constructor({
    baseUrl,
    accessToken,
    userId,
    deviceId,
    isAdministrator = false,
    fetchImpl = globalThis.fetch,
    nowImpl = Date.now,
  } = {}) {
    if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 4096) {
      throw new TypeError('Jellyfin accessToken is required');
    }
    if (!stringId(userId)) throw new TypeError('Jellyfin userId is required');
    if (!stringId(deviceId)) throw new TypeError('Jellyfin deviceId is required');
    if (typeof isAdministrator !== 'boolean') {
      throw new TypeError('isAdministrator must be a boolean');
    }
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    if (typeof nowImpl !== 'function') throw new TypeError('nowImpl must be a function');

    this.#baseUrl = normalizeServerUrl(baseUrl, {
      required: true,
      field: 'Jellyfin baseUrl',
    });
    this.#accessToken = accessToken;
    this.#userId = String(userId);
    this.#deviceId = String(deviceId);
    this.#isAdministrator = isAdministrator;
    this.#fetch = fetchImpl;
    this.#now = nowImpl;
    Object.defineProperties(this, {
      kind: { value: PROVIDER, enumerable: true },
      capabilities: {
        // Jellyfin exposes path discovery and its server-wide library scan only to administrators.
        value: Object.freeze({
          scanLibrary: isAdministrator,
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
    method = 'GET',
    body,
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
      const headers = {
        ...authenticationHeaders(this.#deviceId, this.#accessToken),
        Accept: accept,
      };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      try {
        response = await this.#fetch(joinServerPath(this.#baseUrl, path), {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (cause) {
        const timedOut = controller.signal.aborted;
        throw new MediaProviderError(
          timedOut ? 'Jellyfin server request timed out.' : 'Jellyfin server could not be reached.',
          {
            status: timedOut ? 504 : 502,
            code: timedOut ? 'provider_timeout' : 'provider_unreachable',
            provider: PROVIDER,
            cause,
          }
        );
      }

      if (Number(response?.status) >= 300 && Number(response?.status) < 400) {
        throw new MediaProviderError(
          'Jellyfin server URL returned a redirect; configure its final URL.',
          {
            status: 502,
            code: 'provider_redirect_rejected',
            provider: PROVIDER,
          }
        );
      }
      if (!response || typeof response.ok !== 'boolean') {
        throw new MediaProviderError('Jellyfin returned an invalid response.', {
          status: 502,
          code: 'invalid_provider_response',
          provider: PROVIDER,
        });
      }
      if (!response.ok) {
        const upstreamStatus = Number(response.status);
        const status = Number.isInteger(upstreamStatus) &&
          upstreamStatus >= 400 && upstreamStatus <= 599
          ? upstreamStatus
          : 502;
        throw new MediaProviderError(`Jellyfin request failed (${status}).`, {
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
          throw new MediaProviderError('Jellyfin server request timed out.', {
            status: 504,
            code: 'provider_timeout',
            provider: PROVIDER,
            cause,
          });
        }
        throw new MediaProviderError('Jellyfin returned invalid JSON.', {
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

  async #rawItem(itemId) {
    const id = requireId(itemId, 'Media item id');
    return this.#request(queryPath(`/Items/${encodeURIComponent(id)}`, {
      userId: this.#userId,
    }));
  }

  async listLibraries() {
    const data = await this.#request(queryPath('/UserViews', {
      userId: this.#userId,
      includeExternalContent: false,
    }));
    return array(data?.Items)
      .map((library) => normalizeJellyfinLibrary(library, {
        canScan: this.#isAdministrator,
      }))
      .filter(Boolean);
  }

  async listLibraryPaths() {
    requireAdministrator(this.#isAdministrator);
    const folders = await this.#request('/Library/VirtualFolders');
    const paths = [];
    for (const folder of array(folders)) {
      const library = normalizeJellyfinLibrary(folder, { canScan: true });
      if (!library) continue;
      for (const location of array(folder?.Locations)) {
        if (typeof location !== 'string' || !location) continue;
        paths.push({ path: location, library: library.title, libraryId: library.id });
      }
    }
    return paths;
  }

  async listItems(libraryId) {
    const id = requireId(libraryId, 'Library id');
    const values = [];
    const seen = new Set();
    let startIndex = 0;
    let complete = false;
    const deadline = this.#now() + LIBRARY_DEADLINE_MS;
    while (startIndex < MAX_LIBRARY_ITEMS) {
      const remainingMs = deadline - this.#now();
      if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
        throw new MediaProviderError('Jellyfin library request timed out.', {
          status: 504,
          code: 'provider_timeout',
          provider: PROVIDER,
        });
      }
      const limit = Math.min(LIST_LIMIT, MAX_LIBRARY_ITEMS - startIndex);
      const data = await this.#request(queryPath('/Items', itemQuery(this.#userId, {
        parentId: id,
        recursive: true,
        includeItemTypes: 'Movie,Series',
        startIndex,
        limit,
        enableTotalRecordCount: true,
      })), {
        timeoutMs: Math.max(1, Math.min(METADATA_TIMEOUT_MS, remainingMs)),
      });
      const page = array(data?.Items);
      for (const item of page) {
        const itemId = stringId(item?.Id);
        if (itemId && seen.has(itemId)) {
          throw new MediaProviderError('Jellyfin returned a repeated library page.', {
            status: 502,
            code: 'invalid_provider_response',
            provider: PROVIDER,
          });
        }
        if (itemId) seen.add(itemId);
        values.push(item);
      }
      startIndex += page.length;
      const total = Number(data?.TotalRecordCount);
      if (
        page.length < limit ||
        (Number.isFinite(total) && total >= 0 && startIndex >= total)
      ) {
        complete = true;
        break;
      }
    }
    if (!complete) {
      throw new MediaProviderError('Jellyfin library exceeds the supported item limit.', {
        status: 502,
        code: 'provider_result_limit',
        provider: PROVIDER,
      });
    }
    return normalizeItems(values);
  }

  async listRecentlyAdded(libraryId) {
    const id = requireId(libraryId, 'Library id');
    const data = await this.#request(queryPath('/Items/Latest', itemQuery(this.#userId, {
      parentId: id,
      includeItemTypes: 'Movie,Episode',
      limit: FEED_LIMIT,
      groupItems: false,
    })));
    return normalizeItems(data);
  }

  async listContinueWatching() {
    const data = await this.#request(queryPath('/UserItems/Resume', itemQuery(this.#userId, {
      includeItemTypes: 'Movie,Episode',
      limit: FEED_LIMIT,
      enableTotalRecordCount: false,
    })));
    return normalizeItems(data?.Items);
  }

  async getItem(itemId) {
    const item = normalizeJellyfinItem(await this.#rawItem(itemId));
    if (!item) {
      throw new MediaProviderError('Jellyfin returned an unsupported media item.', {
        status: 502,
        code: 'unsupported_provider_item',
        provider: PROVIDER,
      });
    }
    return item;
  }

  async getSeasons(showId) {
    const id = requireId(showId, 'Show id');
    const data = await this.#request(queryPath(
      `/Shows/${encodeURIComponent(id)}/Seasons`,
      itemQuery(this.#userId)
    ));
    return normalizeItems(data?.Items).filter((item) => item.kind === 'season');
  }

  async getEpisodes(showId, seasonId) {
    const id = requireId(showId, 'Show id');
    const season = seasonId === undefined ? undefined : requireId(seasonId, 'Season id');
    const data = await this.#request(queryPath(
      `/Shows/${encodeURIComponent(id)}/Episodes`,
      itemQuery(this.#userId, { seasonId: season })
    ));
    return normalizeItems(data?.Items).filter((item) => item.kind === 'episode');
  }

  async getRelated(itemId) {
    const id = requireId(itemId, 'Media item id');
    const data = await this.#request(queryPath(
      `/Items/${encodeURIComponent(id)}/Similar`,
      itemQuery(this.#userId, { limit: RELATED_LIMIT })
    ));
    return normalizeItems(data?.Items);
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
    const data = await this.#request(queryPath('/Items', itemQuery(this.#userId, {
      recursive: true,
      searchTerm: normalized,
      includeItemTypes: 'Movie,Series,Episode',
      limit: FEED_LIMIT,
      enableTotalRecordCount: false,
    })));
    return normalizeItems(data?.Items);
  }

  async resolvePlayback(itemId) {
    const id = requireId(itemId, 'Media item id');
    const raw = await this.#rawItem(id);
    const playbackInfo = await this.#request(queryPath(
      `/Items/${encodeURIComponent(id)}/PlaybackInfo`,
      { userId: this.#userId }
    ));
    const mediaSource = firstFileSource(playbackInfo);
    const item = normalizeJellyfinItem({
      ...raw,
      MediaSources: array(playbackInfo?.MediaSources),
    });
    const mediaSourceId = stringId(mediaSource?.Id);
    const playSessionId = stringId(playbackInfo?.PlaySessionId);
    if (!item || !mediaSource || !mediaSourceId || !playSessionId) {
      throw new MediaProviderError(
        'Jellyfin did not return a playable file source for this item.',
        {
          status: 422,
          code: 'playback_source_unavailable',
          provider: PROVIDER,
        }
      );
    }
    return createPlaybackDescriptor({
      item,
      sourcePath: mediaSource.Path,
      resumePositionMs: item.resumePositionMs,
      context: {
        provider: PROVIDER,
        itemId: item.id,
        kind: item.kind,
        seriesId: item.hierarchy.seriesId,
        seasonId: item.hierarchy.seasonId,
        seasonNumber: item.hierarchy.seasonNumber,
        episodeNumber: item.hierarchy.episodeNumber,
        mediaSourceId,
        playSessionId,
      },
    });
  }

  async getNextPlayable(playback) {
    const context = playback?.context || playback;
    if (
      !context ||
      context.provider !== PROVIDER ||
      context.kind !== 'episode' ||
      !context.seriesId ||
      !context.seasonId
    ) {
      return null;
    }
    const episodes = await this.getEpisodes(context.seriesId, context.seasonId);
    const sorted = [...episodes].sort(
      (left, right) => (left.hierarchy.episodeNumber ?? 0) -
        (right.hierarchy.episodeNumber ?? 0)
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
    await this.#request(queryPath(`/UserPlayedItems/${encodeURIComponent(id)}`, {
      userId: this.#userId,
    }), {
      method: watched ? 'POST' : 'DELETE',
      parseJson: false,
    });
  }

  async reportProgress(itemId, progress) {
    const id = requireId(itemId, 'Media item id');
    const state = progress?.state;
    const positionTicks = progressTicks(progress?.positionMs);
    const runTimeTicks = progressTicks(progress?.durationMs);
    const context = progress?.context;
    const mediaSourceId = stringId(context?.mediaSourceId);
    const playSessionId = stringId(context?.playSessionId);
    if (
      !VALID_PROGRESS_STATES.has(state) ||
      positionTicks === null ||
      runTimeTicks === null ||
      !mediaSourceId ||
      !playSessionId ||
      (context?.provider !== undefined && context.provider !== PROVIDER) ||
      (context?.itemId !== undefined && String(context.itemId) !== id)
    ) {
      throw new MediaProviderError('Invalid playback progress.', {
        status: 400,
        code: 'invalid_progress',
        provider: PROVIDER,
      });
    }

    if (state === 'stopped') {
      await this.#request('/Sessions/Playing/Stopped', {
        method: 'POST',
        body: {
          ItemId: id,
          MediaSourceId: mediaSourceId,
          PlaySessionId: playSessionId,
          PositionTicks: positionTicks,
          Failed: false,
        },
        parseJson: false,
      });
      this.#startedSessions.delete(playSessionId);
      return;
    }

    if (!this.#startedSessions.has(playSessionId)) {
      const startBody = {
        ItemId: id,
        MediaSourceId: mediaSourceId,
        PlaySessionId: playSessionId,
        PositionTicks: positionTicks,
        RunTimeTicks: runTimeTicks,
        PlayMethod: 'DirectPlay',
        CanSeek: true,
        IsPaused: state === 'paused',
      };
      await this.#request('/Sessions/Playing', {
        method: 'POST',
        body: startBody,
        parseJson: false,
      });
      if (this.#startedSessions.size >= MAX_STARTED_SESSIONS) {
        this.#startedSessions.delete(this.#startedSessions.values().next().value);
      }
      this.#startedSessions.add(playSessionId);
      return;
    }

    await this.#request('/Sessions/Playing/Progress', {
      method: 'POST',
      body: {
        ItemId: id,
        MediaSourceId: mediaSourceId,
        PlaySessionId: playSessionId,
        PositionTicks: positionTicks,
        RunTimeTicks: runTimeTicks,
        PlayMethod: 'DirectPlay',
        CanSeek: true,
        IsPaused: state === 'paused',
      },
      parseJson: false,
    });
  }

  async scanLibrary(libraryId) {
    // The provider contract identifies a library, but Jellyfin's scan endpoint refreshes all of
    // them. Keep validating the caller's id while accurately advertising this admin capability.
    requireId(libraryId, 'Library id');
    requireAdministrator(this.#isAdministrator);
    await this.#request('/Library/Refresh', {
      method: 'POST',
      parseJson: false,
    });
  }

  openArtwork(ref) {
    let path;
    try {
      path = validateJellyfinImagePath(decodeImageRef(ref, PROVIDER).path);
    } catch (cause) {
      throw new MediaProviderError('Invalid Jellyfin artwork reference.', {
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

function createJellyfinProvider(options) {
  return new JellyfinProvider(options);
}

module.exports = {
  JellyfinProvider,
  createJellyfinProvider,
  normalizeJellyfinLibrary,
  normalizeJellyfinItem,
  validateJellyfinImagePath,
};
