function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function formatRuntime(durationMs) {
  if (!durationMs) return '';
  const minutes = Math.round(durationMs / 60000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function applyAmbientBackground(item) {
  const bg = document.getElementById('ambient-bg');
  const grain = document.getElementById('ambient-grain');
  if (!bg) return;
  const artPath = item.art || item.thumb;
  if (!artPath) {
    bg.classList.remove('visible');
    if (grain) grain.classList.remove('visible');
    return;
  }
  bg.style.backgroundImage = `url(${api.imageUrl(artPath)})`;
  bg.classList.add('visible');
  if (grain) grain.classList.add('visible');
}

function clearAmbientBackground() {
  const bg = document.getElementById('ambient-bg');
  const grain = document.getElementById('ambient-grain');
  if (bg) {
    bg.classList.remove('visible');
    bg.style.backgroundImage = 'none';
  }
  if (grain) grain.classList.remove('visible');
}

const AVATAR_COLORS = ['#5b4636', '#3d5a5b', '#4a4e69', '#6b4d57', '#3f5f52', '#5a5238', '#4b4b6b'];

function colorForName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function initialsForName(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function renderMetaLine(item) {
  const parts = [];
  if (item.year) parts.push(item.year);
  const runtime = formatRuntime(item.duration);
  if (runtime) parts.push(runtime);
  if (item.contentRating) parts.push(item.contentRating);
  return parts.join(' · ');
}

function renderGenres(item) {
  if (!item.Genre || !item.Genre.length) return '';
  return item.Genre.map((g) => g.tag).join(', ');
}

function renderRatingBadges(item) {
  const parts = [];
  if (item.audienceRating) parts.push(`<span>❤ ${Math.round(item.audienceRating * 10)}%</span>`);
  if (item.rating) parts.push(`<span>🍅 ${Math.round(item.rating * 10)}%</span>`);
  if (!parts.length) return '';
  return `<div class="rating-badges">${parts.join('')}</div>`;
}

function renderTechSpecs(item) {
  const media = item.Media && item.Media[0];
  if (!media) return '';
  const streams = (media.Part && media.Part[0] && media.Part[0].Stream) || [];
  const audio = streams.find((s) => s.streamType === 2);
  const subtitle = streams.find((s) => s.streamType === 3);

  const rows = [];
  rows.push(
    `<div class="row"><div class="label">Video</div><div>${media.videoResolution || ''}p (${(media.videoCodec || '').toUpperCase()})</div></div>`
  );
  if (audio) {
    const channels = audio.channels ? ` ${audio.channels}.0` : '';
    rows.push(
      `<div class="row"><div class="label">Audio</div><div>${escapeHtml(audio.language || '')} (${(audio.codec || '').toUpperCase()}${channels})</div></div>`
    );
  }
  if (subtitle) {
    rows.push(
      `<div class="row"><div class="label">Subtitles</div><div>${escapeHtml(subtitle.language || '')} (${(subtitle.codec || '').toUpperCase()})</div></div>`
    );
  }
  return `<div class="tech-specs">${rows.join('')}</div>`;
}

function renderCastRow(item) {
  if (!item.Role || !item.Role.length) return null;
  const wrap = document.createElement('div');
  wrap.className = 'cast-section';

  const heading = document.createElement('div');
  heading.className = 'section-heading';
  heading.textContent = 'Cast & Crew';
  wrap.appendChild(heading);

  const row = document.createElement('div');
  row.className = 'cast-row';
  for (const person of item.Role) {
    const card = document.createElement('div');
    card.className = 'cast-member';
    const photo = person.thumb
      ? `<img src="${person.thumb}" alt="${escapeHtml(person.tag)}" loading="lazy" />`
      : `<div class="cast-photo-placeholder" style="background:${colorForName(person.tag)}">${initialsForName(person.tag)}</div>`;
    card.innerHTML = `
      ${photo}
      <div class="name">${escapeHtml(person.tag)}</div>
      <div class="role">${escapeHtml(person.role || '')}</div>
    `;
    row.appendChild(card);
  }
  wrap.appendChild(row);
  return wrap;
}

function renderWatchedButton(item, onToggle) {
  const btn = document.createElement('button');
  btn.className = 'icon-button' + (item.viewCount ? ' active' : '');
  btn.title = item.viewCount ? 'Mark unwatched' : 'Mark watched';
  btn.textContent = '✓';
  btn.addEventListener('click', () => onToggle(btn, item));
  return btn;
}

function renderMovieDetail(item, onPlay, onToggleWatched) {
  const wrap = document.createElement('div');
  wrap.className = 'detail-wrap';
  applyAmbientBackground(item);

  const el = document.createElement('div');
  el.className = 'detail';

  const poster = document.createElement('img');
  poster.className = 'poster';
  poster.src = api.imageUrl(item.thumb);
  poster.alt = item.title;

  const info = document.createElement('div');
  info.className = 'info';
  info.innerHTML = `
    <h1>${escapeHtml(item.title)}</h1>
    ${item.Director && item.Director.length ? `<div class="subtitle">Directed by ${escapeHtml(item.Director.map((d) => d.tag).join(', '))}</div>` : ''}
    <div class="meta">${renderMetaLine(item)}</div>
    <div class="meta">${escapeHtml(renderGenres(item))}</div>
    ${renderRatingBadges(item)}
  `;

  const actionRow = document.createElement('div');
  actionRow.className = 'action-row';
  const playBtn = document.createElement('button');
  playBtn.className = 'play-button';
  playBtn.innerHTML = item.viewOffset ? '▶ Resume' : '▶ Play';
  playBtn.addEventListener('click', onPlay);
  actionRow.append(playBtn, renderWatchedButton(item, onToggleWatched));
  info.appendChild(actionRow);

  const overview = document.createElement('p');
  overview.className = 'overview';
  overview.textContent = item.summary || '';
  info.appendChild(overview);

  const techSpecsHtml = renderTechSpecs(item);
  if (techSpecsHtml) {
    // Never `info.innerHTML += ...` here: that serializes the whole subtree back to a string and
    // reparses it, silently destroying every addEventListener listener already attached inside it
    // (the Play and Mark-watched buttons above) even though the resulting markup looks identical.
    // A <template> parses the string into real nodes without touching info's existing children.
    const template = document.createElement('template');
    template.innerHTML = techSpecsHtml;
    info.appendChild(template.content);
  }

  el.append(poster, info);
  wrap.appendChild(el);

  const castRow = renderCastRow(item);
  if (castRow) wrap.appendChild(castRow);

  return wrap;
}

function renderShowHeader(show, onDeckEpisode, onContinue, onToggleWatched) {
  const wrap = document.createElement('div');
  wrap.className = 'detail-wrap';
  applyAmbientBackground(show);

  const el = document.createElement('div');
  el.className = 'detail';

  const poster = document.createElement('img');
  poster.className = 'poster';
  poster.src = api.imageUrl(show.thumb);
  poster.alt = show.title;

  const info = document.createElement('div');
  info.className = 'info';
  info.innerHTML = `
    <h1>${escapeHtml(show.title)}</h1>
    <div class="meta">${renderMetaLine(show)}</div>
    <div class="meta">${escapeHtml(renderGenres(show))}</div>
    ${renderRatingBadges(show)}
  `;

  const actionRow = document.createElement('div');
  actionRow.className = 'action-row';
  if (onDeckEpisode) {
    const continueBtn = document.createElement('button');
    continueBtn.className = 'play-button';
    continueBtn.innerHTML = `▶ Continue: S${onDeckEpisode.parentIndex} · E${onDeckEpisode.index}`;
    continueBtn.addEventListener('click', () => onContinue(onDeckEpisode));
    actionRow.appendChild(continueBtn);
  }
  actionRow.appendChild(renderWatchedButton(show, onToggleWatched));
  info.appendChild(actionRow);

  if (show.leafCount) {
    const progress = document.createElement('p');
    progress.className = 'progress-line';
    progress.textContent = `${show.viewedLeafCount || 0} of ${show.leafCount} episodes watched`;
    info.appendChild(progress);
  }

  const overview = document.createElement('p');
  overview.className = 'overview';
  overview.textContent = show.summary || '';
  info.appendChild(overview);

  el.append(poster, info);
  wrap.appendChild(el);

  const castRow = renderCastRow(show);
  if (castRow) wrap.appendChild(castRow);

  return wrap;
}

function renderSeasonGrid(seasons, activeSeasonId, onSelect) {
  const wrap = document.createElement('div');

  const heading = document.createElement('div');
  heading.className = 'section-heading';
  heading.textContent = 'Seasons';
  wrap.appendChild(heading);

  const grid = document.createElement('div');
  grid.className = 'poster-grid season-grid';

  for (const season of seasons) {
    const card = document.createElement('div');
    card.className = 'poster-card' + (season.ratingKey === activeSeasonId ? ' active' : '');
    card.tabIndex = 0;

    const posterWrap = document.createElement('div');
    posterWrap.className = 'poster-wrap';

    const img = document.createElement('img');
    img.src = api.imageUrl(season.thumb);
    img.alt = season.title;
    img.loading = 'lazy';
    posterWrap.appendChild(img);

    if (season.leafCount) {
      const badge = document.createElement('div');
      badge.className = 'count-badge';
      badge.textContent = season.leafCount;
      posterWrap.appendChild(badge);
    }

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = season.title;

    const sub = document.createElement('div');
    sub.className = 'year';
    sub.textContent = `${season.leafCount || 0} episode${season.leafCount === 1 ? '' : 's'}`;

    card.append(posterWrap, title, sub);
    card.addEventListener('click', () => onSelect(season));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') onSelect(season);
    });

    grid.appendChild(card);
  }

  wrap.appendChild(grid);
  return wrap;
}

function renderEpisodeGrid(episodes, onPlayEpisode, onToggleWatched) {
  const wrap = document.createElement('div');

  const heading = document.createElement('div');
  heading.className = 'section-heading';
  heading.textContent = `${episodes.length} Episode${episodes.length === 1 ? '' : 's'}`;
  wrap.appendChild(heading);

  const grid = document.createElement('div');
  grid.className = 'episode-grid';

  for (const episode of episodes) {
    const card = document.createElement('div');
    card.className = 'episode-card';
    card.tabIndex = 0;

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'thumb-wrap';

    const img = document.createElement('img');
    img.src = api.imageUrl(episode.thumb);
    img.alt = '';
    img.loading = 'lazy';
    thumbWrap.appendChild(img);

    if (episode.viewOffset && episode.duration) {
      const track = document.createElement('div');
      track.className = 'progress-track';
      const fill = document.createElement('div');
      fill.className = 'progress-fill';
      fill.style.width = `${Math.min(100, (episode.viewOffset / episode.duration) * 100)}%`;
      track.appendChild(fill);
      thumbWrap.appendChild(track);
    }

    const watchedBadge = document.createElement('button');
    watchedBadge.className = 'watched-badge' + (episode.viewCount ? ' active' : '');
    watchedBadge.title = episode.viewCount ? 'Mark unwatched' : 'Mark watched';
    watchedBadge.textContent = '✓';
    watchedBadge.addEventListener('click', (e) => {
      e.stopPropagation();
      onToggleWatched(watchedBadge, episode);
    });
    thumbWrap.appendChild(watchedBadge);

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = episode.title;

    const sub = document.createElement('div');
    sub.className = 'subtitle-line';
    sub.textContent = episode.viewOffset ? `Episode ${episode.index} · Resume` : `Episode ${episode.index}`;

    card.append(thumbWrap, title, sub);
    card.addEventListener('click', () => onPlayEpisode(episode));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') onPlayEpisode(episode);
    });

    grid.appendChild(card);
  }

  wrap.appendChild(grid);
  return wrap;
}
