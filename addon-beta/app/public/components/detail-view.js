// Kept as a global for the existing Settings view. Browsing views below build untrusted metadata
// with DOM APIs instead of interpolating it into HTML.
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function formatRuntime(durationMs) {
  if (!durationMs) return '';
  const minutes = Math.round(Number(durationMs) / 60000);
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return hours > 0 ? `${hours}h ${remaining}m` : `${remaining}m`;
}

function createTextElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text || '';
  return element;
}

function applyAmbientBackground(item) {
  const background = document.getElementById('ambient-bg');
  const grain = document.getElementById('ambient-grain');
  const artwork = item?.images?.backdrop || item?.images?.poster;
  if (!background || !artwork) {
    clearAmbientBackground();
    return;
  }
  background.src = api.imageUrl(artwork);
  background.classList.add('visible');
  if (grain) grain.classList.add('visible');
}

function clearAmbientBackground() {
  const background = document.getElementById('ambient-bg');
  const grain = document.getElementById('ambient-grain');
  if (background) {
    background.classList.remove('visible');
    background.removeAttribute('src');
  }
  if (grain) grain.classList.remove('visible');
}

function colorIndexForName(name) {
  let hash = 0;
  const value = String(name || '');
  for (let index = 0; index < value.length; index++) {
    hash = value.charCodeAt(index) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % 7;
}

function initialsForName(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function renderMetaLine(item) {
  const parts = [];
  if (item?.year) parts.push(String(item.year));
  const runtime = formatRuntime(item?.durationMs);
  if (runtime) parts.push(runtime);
  if (item?.contentRating) parts.push(String(item.contentRating));
  return parts.join(' · ');
}

function ratingPercent(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.round(Math.min(100, number));
}

function renderRatingBadges(item) {
  const critic = ratingPercent(item?.ratings?.critic);
  const audience = ratingPercent(item?.ratings?.audience);
  if (critic === null && audience === null) return null;
  const badges = document.createElement('div');
  badges.className = 'rating-badges';
  if (audience !== null) badges.appendChild(createTextElement('span', '', `❤ ${audience}%`));
  if (critic !== null) badges.appendChild(createTextElement('span', '', `🍅 ${critic}%`));
  return badges;
}

function formatResolution(value) {
  const resolution = String(value || '');
  if (!resolution) return '';
  return /^\d+$/.test(resolution) ? `${resolution}p` : resolution;
}

function createSpecRow(label, value) {
  const row = document.createElement('div');
  row.className = 'row';
  row.append(
    createTextElement('div', 'label', label),
    createTextElement('div', '', value)
  );
  return row;
}

function renderTechSpecs(item) {
  const technical = item?.technical || {};
  const video = technical.video || {};
  const audio = Array.isArray(technical.audioTracks) ? technical.audioTracks[0] : null;
  const subtitle = Array.isArray(technical.subtitleTracks) ? technical.subtitleTracks[0] : null;
  if (!video.resolution && !video.codec && !audio && !subtitle) return null;

  const wrap = document.createElement('div');
  wrap.className = 'tech-specs';
  if (video.resolution || video.codec) {
    const description = [
      formatResolution(video.resolution),
      video.codec ? `(${String(video.codec).toUpperCase()})` : '',
    ].filter(Boolean).join(' ');
    wrap.appendChild(createSpecRow('Video', description));
  }
  if (audio) {
    const channels = audio.channels ? ` ${audio.channels}.0` : '';
    const details = audio.codec ? ` (${String(audio.codec).toUpperCase()}${channels})` : '';
    wrap.appendChild(createSpecRow('Audio', `${audio.language || ''}${details}`.trim()));
  }
  if (subtitle) {
    const details = subtitle.codec ? ` (${String(subtitle.codec).toUpperCase()})` : '';
    wrap.appendChild(createSpecRow('Subtitles', `${subtitle.language || ''}${details}`.trim()));
  }
  return wrap;
}

function renderCastRow(item) {
  if (!Array.isArray(item?.cast) || !item.cast.length) return null;
  const wrap = document.createElement('section');
  wrap.className = 'cast-section';
  wrap.appendChild(createTextElement('h2', 'section-heading', 'Cast & Crew'));

  const row = document.createElement('div');
  row.className = 'cast-row';
  for (const person of item.cast) {
    const card = document.createElement('article');
    card.className = 'cast-member';
    if (person.image) {
      const image = document.createElement('img');
      image.src = api.imageUrl(person.image);
      image.alt = person.name || '';
      image.loading = 'lazy';
      card.appendChild(image);
    } else {
      const placeholder = createTextElement(
        'div',
        `cast-photo-placeholder avatar-color-${colorIndexForName(person.name)}`,
        initialsForName(person.name)
      );
      placeholder.setAttribute('aria-hidden', 'true');
      card.appendChild(placeholder);
    }
    card.append(
      createTextElement('div', 'name', person.name),
      createTextElement('div', 'role', person.role)
    );
    row.appendChild(card);
  }
  wrap.appendChild(row);
  return wrap;
}

function setWatchedButtonState(button, item) {
  const watched = Boolean(item?.watched);
  button.classList.toggle('active', watched);
  button.title = watched ? 'Mark unwatched' : 'Mark watched';
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-pressed', String(watched));
}

function renderWatchedButton(item, onToggle, className = 'icon-button') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = '✓';
  setWatchedButtonState(button, item);
  button.addEventListener('click', () => onToggle(button, item));
  return button;
}

function createDetailPoster(item) {
  const posterRef = item?.images?.poster || item?.images?.thumbnail;
  if (!posterRef) return createTextElement('div', 'poster detail-poster-placeholder', 'No artwork');
  const poster = document.createElement('img');
  poster.className = 'poster';
  poster.src = api.imageUrl(posterRef);
  poster.alt = `${item.title || 'Media'} poster`;
  return poster;
}

function appendCommonMetadata(info, item, directors = []) {
  const title = createTextElement('h1', '', item.title);
  title.tabIndex = -1;
  info.appendChild(title);
  if (directors.length) {
    info.appendChild(createTextElement('div', 'subtitle', `Directed by ${directors.join(', ')}`));
  }
  const meta = renderMetaLine(item);
  if (meta) info.appendChild(createTextElement('div', 'meta', meta));
  if (Array.isArray(item.genres) && item.genres.length) {
    info.appendChild(createTextElement('div', 'meta', item.genres.join(', ')));
  }
  const ratings = renderRatingBadges(item);
  if (ratings) info.appendChild(ratings);
}

function renderMovieDetail(item, onPlay, onToggleWatched) {
  const wrap = document.createElement('div');
  wrap.className = 'detail-wrap';
  applyAmbientBackground(item);

  const detail = document.createElement('div');
  detail.className = 'detail';
  const info = document.createElement('div');
  info.className = 'info';
  appendCommonMetadata(info, item, Array.isArray(item.directors) ? item.directors : []);

  const actionRow = document.createElement('div');
  actionRow.className = 'action-row';
  if (item.playable !== false) {
    const playButton = createTextElement(
      'button',
      'play-button',
      item.resumePositionMs ? '▶ Resume' : '▶ Play'
    );
    playButton.type = 'button';
    playButton.addEventListener('click', onPlay);
    actionRow.appendChild(playButton);
  }
  actionRow.appendChild(renderWatchedButton(item, onToggleWatched));
  info.appendChild(actionRow);

  if (item.summary) info.appendChild(createTextElement('p', 'overview', item.summary));
  const technical = renderTechSpecs(item);
  if (technical) info.appendChild(technical);

  detail.append(createDetailPoster(item), info);
  wrap.appendChild(detail);
  const cast = renderCastRow(item);
  if (cast) wrap.appendChild(cast);
  return wrap;
}

function renderShowHeader(series, nextEpisode, onContinue, onToggleWatched) {
  const wrap = document.createElement('div');
  wrap.className = 'detail-wrap';
  applyAmbientBackground(series);

  const detail = document.createElement('div');
  detail.className = 'detail';
  const info = document.createElement('div');
  info.className = 'info';
  appendCommonMetadata(info, series);

  const actionRow = document.createElement('div');
  actionRow.className = 'action-row';
  if (nextEpisode?.playable !== false && nextEpisode) {
    const seasonNumber = nextEpisode.hierarchy?.seasonNumber || '?';
    const episodeNumber = nextEpisode.hierarchy?.episodeNumber || '?';
    const continueButton = createTextElement(
      'button',
      'play-button',
      `▶ Continue: S${seasonNumber} · E${episodeNumber}`
    );
    continueButton.type = 'button';
    continueButton.addEventListener('click', () => onContinue(nextEpisode));
    actionRow.appendChild(continueButton);
  }
  actionRow.appendChild(renderWatchedButton(series, onToggleWatched));
  info.appendChild(actionRow);

  const episodeCount = Number(series.counts?.episodes || 0);
  if (episodeCount > 0) {
    const watchedCount = Number(series.counts?.watchedEpisodes || 0);
    info.appendChild(createTextElement(
      'p',
      'progress-line',
      `${watchedCount} of ${episodeCount} episodes watched`
    ));
  }
  if (series.summary) info.appendChild(createTextElement('p', 'overview', series.summary));

  detail.append(createDetailPoster(series), info);
  wrap.appendChild(detail);
  const cast = renderCastRow(series);
  if (cast) wrap.appendChild(cast);
  return wrap;
}

function renderSeasonGrid(seasons, activeSeasonId, onSelect) {
  const wrap = document.createElement('section');
  const heading = createTextElement('h2', 'section-heading', 'Seasons');
  heading.id = 'season-tabs-heading';
  wrap.appendChild(heading);
  const grid = document.createElement('div');
  grid.className = 'poster-grid season-grid';
  grid.setAttribute('role', 'tablist');
  grid.setAttribute('aria-labelledby', heading.id);

  for (const [index, season] of seasons.entries()) {
    const selected = season.id === activeSeasonId;
    const card = document.createElement('button');
    card.type = 'button';
    card.id = `season-tab-${index}`;
    card.className = 'poster-card' + (selected ? ' active' : '');
    card.setAttribute('role', 'tab');
    card.setAttribute('aria-selected', String(selected));
    card.setAttribute('aria-controls', 'season-episode-panel');
    card.setAttribute('aria-label', season.title || `Season ${index + 1}`);
    card.tabIndex = selected ? 0 : -1;

    const posterWrap = document.createElement('span');
    posterWrap.className = 'poster-wrap';
    const posterRef = season.images?.poster || season.images?.thumbnail;
    if (posterRef) {
      const image = document.createElement('img');
      image.src = api.imageUrl(posterRef);
      image.alt = '';
      image.loading = 'lazy';
      posterWrap.appendChild(image);
    } else {
      posterWrap.appendChild(createTextElement('span', 'poster-placeholder', 'No artwork'));
    }

    const count = Number(season.counts?.episodes || season.counts?.children || 0);
    if (count > 0) {
      const badge = createTextElement('span', 'count-badge', String(count));
      badge.setAttribute('aria-hidden', 'true');
      posterWrap.appendChild(badge);
    }
    card.append(
      posterWrap,
      createTextElement('span', 'title', season.title),
      createTextElement('span', 'year', `${count} episode${count === 1 ? '' : 's'}`)
    );
    card.addEventListener('click', () => onSelect(season));
    card.addEventListener('keydown', (event) => {
      let nextIndex;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % seasons.length;
      else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + seasons.length) % seasons.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = seasons.length - 1;
      else return;
      event.preventDefault();
      onSelect(seasons[nextIndex]);
    });
    grid.appendChild(card);
  }

  wrap.appendChild(grid);
  return wrap;
}

function renderEpisodeGrid(episodes, onPlayEpisode, onToggleWatched) {
  const wrap = document.createElement('section');
  wrap.appendChild(createTextElement(
    'h2',
    'section-heading',
    `${episodes.length} Episode${episodes.length === 1 ? '' : 's'}`
  ));
  const grid = document.createElement('div');
  grid.className = 'episode-grid';

  for (const episode of episodes) {
    const card = document.createElement('article');
    card.className = 'episode-card';
    const playButton = document.createElement('button');
    playButton.type = 'button';
    playButton.className = 'episode-main';
    playButton.disabled = episode.playable === false;
    const number = episode.hierarchy?.episodeNumber;
    playButton.setAttribute(
      'aria-label',
      `${episode.title}${number ? `, episode ${number}` : ''}${episode.resumePositionMs ? ', resume' : ''}`
    );

    const thumbWrap = document.createElement('span');
    thumbWrap.className = 'thumb-wrap';
    const imageRef = episode.images?.thumbnail || episode.images?.poster;
    if (imageRef) {
      const image = document.createElement('img');
      image.src = api.imageUrl(imageRef);
      image.alt = '';
      image.loading = 'lazy';
      thumbWrap.appendChild(image);
    } else {
      thumbWrap.appendChild(createTextElement('span', 'episode-placeholder', 'No artwork'));
    }

    const progressValue = MediaLauncherMediaModel.progressPercent(episode);
    if (progressValue > 0) {
      const progress = document.createElement('progress');
      progress.className = 'progress-track';
      progress.max = 100;
      progress.value = progressValue;
      progress.setAttribute('aria-label', `${Math.round(progressValue)}% watched`);
      thumbWrap.appendChild(progress);
    }

    const episodeLabel = number ? `Episode ${number}` : 'Episode';
    playButton.append(
      thumbWrap,
      createTextElement('span', 'title', episode.title),
      createTextElement(
        'span',
        'subtitle-line',
        episode.resumePositionMs ? `${episodeLabel} · Resume` : episodeLabel
      )
    );
    playButton.addEventListener('click', () => onPlayEpisode(episode));

    const watched = renderWatchedButton(episode, onToggleWatched, 'watched-badge');
    card.append(playButton, watched);
    grid.appendChild(card);
  }

  wrap.appendChild(grid);
  return wrap;
}
