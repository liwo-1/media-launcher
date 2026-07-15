'use strict';

const LIBRARY_KINDS = new Set(['movie', 'series']);
const ITEM_KINDS = new Set(['movie', 'series', 'season', 'episode']);

class MediaProviderError extends Error {
  constructor(message, { status = 502, code = 'provider_error', provider = '', cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'MediaProviderError';
    this.status = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;
    this.code = typeof code === 'string' && code ? code : 'provider_error';
    this.provider = typeof provider === 'string' ? provider : '';
  }
}

function requiredString(value, field) {
  if (typeof value !== 'string' || !value) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value) {
  return typeof value === 'string' && value ? value : null;
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegativeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry === 'string' && entry)
    .map((entry) => entry);
}

function createLibrary(input) {
  const provider = requiredString(input?.provider, 'library.provider');
  const kind = requiredString(input?.kind, 'library.kind');
  if (!LIBRARY_KINDS.has(kind)) throw new TypeError(`Unsupported library kind: ${kind}`);

  return {
    id: requiredString(input?.id, 'library.id'),
    title: requiredString(input?.title, 'library.title'),
    kind,
    canScan: input?.canScan === true,
    provider,
  };
}

function createMediaItem(input) {
  const provider = requiredString(input?.provider, 'item.provider');
  const kind = requiredString(input?.kind, 'item.kind');
  if (!ITEM_KINDS.has(kind)) throw new TypeError(`Unsupported media item kind: ${kind}`);

  const images = input?.images || {};
  const hierarchy = input?.hierarchy || {};
  const counts = input?.counts || {};
  const ratings = input?.ratings || {};
  const technical = input?.technical || {};
  const video = technical.video || {};

  return {
    id: requiredString(input?.id, 'item.id'),
    provider,
    kind,
    title: requiredString(input?.title, 'item.title'),
    year: optionalNumber(input?.year),
    summary: typeof input?.summary === 'string' ? input.summary : '',
    contentRating: optionalString(input?.contentRating),
    durationMs: nonNegativeNumber(input?.durationMs),
    resumePositionMs: nonNegativeNumber(input?.resumePositionMs),
    watched: input?.watched === true,
    playable: input?.playable === true,
    images: {
      poster: optionalString(images.poster),
      backdrop: optionalString(images.backdrop),
      thumbnail: optionalString(images.thumbnail),
    },
    hierarchy: {
      seriesId: optionalString(hierarchy.seriesId),
      seasonId: optionalString(hierarchy.seasonId),
      seriesTitle: optionalString(hierarchy.seriesTitle),
      seasonTitle: optionalString(hierarchy.seasonTitle),
      seasonNumber: optionalNumber(hierarchy.seasonNumber),
      episodeNumber: optionalNumber(hierarchy.episodeNumber),
    },
    counts: {
      children: nonNegativeNumber(counts.children),
      episodes: nonNegativeNumber(counts.episodes),
      watchedEpisodes: nonNegativeNumber(counts.watchedEpisodes),
    },
    genres: stringList(input?.genres),
    directors: stringList(input?.directors),
    cast: Array.isArray(input?.cast)
      ? input.cast
        .filter((person) => person && typeof person.name === 'string' && person.name)
        .map((person) => ({
          name: person.name,
          role: typeof person.role === 'string' ? person.role : '',
          image: optionalString(person.image),
        }))
      : [],
    ratings: {
      critic: optionalNumber(ratings.critic),
      audience: optionalNumber(ratings.audience),
    },
    technical: {
      video: {
        resolution: optionalString(video.resolution),
        codec: optionalString(video.codec),
      },
      audioTracks: Array.isArray(technical.audioTracks)
        ? technical.audioTracks.map((track) => ({
          language: optionalString(track?.language),
          codec: optionalString(track?.codec),
          channels: optionalNumber(track?.channels),
        }))
        : [],
      subtitleTracks: Array.isArray(technical.subtitleTracks)
        ? technical.subtitleTracks.map((track) => ({
          language: optionalString(track?.language),
          codec: optionalString(track?.codec),
          forced: track?.forced === true,
        }))
        : [],
    },
    addedAt: optionalString(input?.addedAt),
  };
}

function createPlaybackDescriptor({ item, sourcePath, resumePositionMs, context }) {
  const canonicalItem = createMediaItem(item);
  if (typeof sourcePath !== 'string' || !sourcePath) {
    throw new TypeError('playback sourcePath must be a non-empty string');
  }
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw new TypeError('playback context must be an object');
  }

  return {
    item: canonicalItem,
    sourcePath,
    resumePositionMs: nonNegativeNumber(resumePositionMs),
    context: { ...context },
  };
}

module.exports = {
  LIBRARY_KINDS,
  ITEM_KINDS,
  MediaProviderError,
  createLibrary,
  createMediaItem,
  createPlaybackDescriptor,
};
