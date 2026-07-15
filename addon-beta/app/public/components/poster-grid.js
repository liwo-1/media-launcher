function renderPosterGrid(items, onSelect) {
  const grid = document.createElement('div');
  grid.className = 'poster-grid';

  for (const item of items) grid.appendChild(renderPosterCard(item, onSelect));
  return grid;
}

function renderPosterCard(item, onSelect, presentation = null) {
  const labels = presentation || MediaLauncherMediaModel.cardPresentation(item);
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'poster-card';
  card.setAttribute(
    'aria-label',
    [labels.title, labels.subtitle].filter(Boolean).join(', ') || 'Open media item'
  );

  const posterWrap = document.createElement('span');
  posterWrap.className = 'poster-wrap';

  const posterRef = item?.images?.poster || item?.images?.thumbnail;
  if (posterRef) {
    const img = document.createElement('img');
    img.src = api.imageUrl(posterRef);
    img.alt = '';
    img.loading = 'lazy';
    posterWrap.appendChild(img);
  } else {
    const placeholder = document.createElement('span');
    placeholder.className = 'poster-placeholder';
    placeholder.textContent = 'No artwork';
    posterWrap.appendChild(placeholder);
  }

  const childCount = Number(item?.counts?.children || item?.counts?.episodes || 0);
  if (childCount > 0) {
    const badge = document.createElement('span');
    badge.className = 'count-badge';
    badge.textContent = String(childCount);
    badge.setAttribute('aria-hidden', 'true');
    posterWrap.appendChild(badge);
  }

  const progressValue = MediaLauncherMediaModel.progressPercent(item);
  if (progressValue > 0) {
    const progress = document.createElement('progress');
    progress.className = 'progress-track';
    progress.max = 100;
    progress.value = progressValue;
    progress.setAttribute('aria-label', `${Math.round(progressValue)}% watched`);
    posterWrap.appendChild(progress);
  }

  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = labels.title;

  const subtitle = document.createElement('span');
  subtitle.className = 'year';
  subtitle.textContent = labels.subtitle;

  card.append(posterWrap, title, subtitle);
  card.addEventListener('click', () => onSelect(item));
  return card;
}
