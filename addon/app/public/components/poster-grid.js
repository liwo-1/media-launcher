function renderPosterGrid(items, onSelect) {
  const grid = document.createElement('div');
  grid.className = 'poster-grid';

  for (const item of items) {
    grid.appendChild(renderPosterCard(item, onSelect));
  }

  return grid;
}

function renderPosterCard(item, onSelect) {
  const card = document.createElement('div');
  card.className = 'poster-card';
  card.tabIndex = 0;

  const posterWrap = document.createElement('div');
  posterWrap.className = 'poster-wrap';

  const img = document.createElement('img');
  img.src = api.imageUrl(item.thumb);
  img.alt = item.title;
  img.loading = 'lazy';
  posterWrap.appendChild(img);

  if (item.childCount) {
    const badge = document.createElement('div');
    badge.className = 'count-badge';
    badge.textContent = item.childCount;
    posterWrap.appendChild(badge);
  }

  if (item.viewOffset && item.duration) {
    const track = document.createElement('div');
    track.className = 'progress-track';
    const fill = document.createElement('div');
    fill.className = 'progress-fill';
    fill.style.width = `${Math.min(100, (item.viewOffset / item.duration) * 100)}%`;
    track.appendChild(fill);
    posterWrap.appendChild(track);
  }

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = item.grandparentTitle ? `${item.grandparentTitle}` : item.title;

  const year = document.createElement('div');
  year.className = 'year';
  year.textContent = item.grandparentTitle
    ? item.title
    : item.year || '';

  card.append(posterWrap, title, year);
  card.addEventListener('click', () => onSelect(item));
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') onSelect(item);
  });

  return card;
}
