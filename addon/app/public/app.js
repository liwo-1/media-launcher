const appEl = document.getElementById('app');
const toastEl = document.getElementById('toast');

let toastTimeout;
function showToast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toastEl.classList.add('hidden'), 3000);
}

async function handlePlay(itemId, label) {
  showToast(`Starting "${label}"...`);
  try {
    await api.play(itemId);
    showToast(`Now playing "${label}"`);
  } catch (err) {
    showToast(err.message, true);
  }
}

async function handleToggleWatched(btn, item) {
  try {
    if (item.viewCount) {
      await api.markUnwatched(item.ratingKey);
      item.viewCount = 0;
      btn.classList.remove('active');
      btn.title = 'Mark watched';
    } else {
      await api.markWatched(item.ratingKey);
      item.viewCount = 1;
      btn.classList.add('active');
      btn.title = 'Mark unwatched';
    }
  } catch (err) {
    showToast(err.message, true);
  }
}

function setActiveNav(section) {
  document.querySelectorAll('#nav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === section);
  });
}

let librariesCache = null;
async function getLibraryKey(plexType) {
  if (!librariesCache) {
    librariesCache = await api.getLibraries();
  }
  const lib = librariesCache.Items.find((v) => v.type === plexType);
  if (!lib) throw new Error(`No "${plexType}" library found in Plex`);
  return lib.key;
}

async function renderContinueWatching(container) {
  let onDeck;
  try {
    onDeck = await api.getOnDeck();
  } catch {
    return; // Continue Watching is a nice-to-have; don't block the page on it failing.
  }
  if (!onDeck.Items.length) return;

  const heading = document.createElement('div');
  heading.className = 'section-heading';
  heading.textContent = 'Continue Watching';
  container.appendChild(heading);

  const row = document.createElement('div');
  row.className = 'continue-row';
  for (const item of onDeck.Items) {
    row.appendChild(
      renderPosterCard(item, () => {
        // Navigate to the title page rather than playing directly - the show/movie detail view
        // has its own Play/Continue button, matching how the browsing grids behave.
        if (item.type === 'episode') {
          window.location.hash = `#/show/${item.grandparentRatingKey}`;
        } else {
          window.location.hash = `#/item/${item.ratingKey}`;
        }
      })
    );
  }
  container.appendChild(row);
}

async function renderRelatedSection(container, itemId) {
  let related;
  try {
    related = await api.getRelated(itemId);
  } catch {
    return; // nice-to-have, don't block the page on it failing.
  }
  if (!related.Items.length) return;

  const heading = document.createElement('div');
  heading.className = 'section-heading';
  heading.textContent = 'Related';
  container.appendChild(heading);

  const row = document.createElement('div');
  row.className = 'continue-row';
  for (const item of related.Items) {
    row.appendChild(
      renderPosterCard(item, () => {
        window.location.hash =
          item.type === 'show' ? `#/show/${item.ratingKey}` : `#/item/${item.ratingKey}`;
      })
    );
  }
  container.appendChild(row);
}

async function renderRecentlyAddedRow(container, libraryKey, onSelect) {
  let recent;
  try {
    recent = await api.getRecentlyAdded(libraryKey);
  } catch {
    return; // nice-to-have, don't block the page on it failing.
  }
  if (!recent.Items.length) return;

  // TV libraries return recently-added EPISODES (one per new file), which would otherwise spam
  // this row with every episode of the same season dump. Collapse to one card per season instead,
  // keeping only the first (most recent) episode seen for each season.
  let items = recent.Items;
  if (items[0].type === 'episode') {
    const seenSeasons = new Set();
    items = items
      .filter((ep) => {
        if (seenSeasons.has(ep.parentRatingKey)) return false;
        seenSeasons.add(ep.parentRatingKey);
        return true;
      })
      .map((ep) => ({
        ratingKey: ep.grandparentRatingKey,
        title: ep.grandparentTitle,
        year: ep.parentTitle, // shows as the subtitle line, e.g. "Season 4"
        thumb: ep.parentThumb,
      }));
  }

  const heading = document.createElement('div');
  heading.className = 'section-heading';
  heading.textContent = 'Recently Added';
  container.appendChild(heading);

  const row = document.createElement('div');
  row.className = 'continue-row';
  for (const item of items) {
    row.appendChild(renderPosterCard(item, () => onSelect(item)));
  }
  container.appendChild(row);
}

async function renderHomeMovies() {
  setActiveNav('movies');
  clearAmbientBackground();
  appEl.innerHTML = '';
  await renderContinueWatching(appEl);
  try {
    const libraryKey = await getLibraryKey('movie');
    await renderRecentlyAddedRow(appEl, libraryKey, (item) => {
      window.location.hash = `#/item/${item.ratingKey}`;
    });
    const gridHeading = document.createElement('div');
    gridHeading.className = 'section-heading';
    gridHeading.textContent = 'Movies';
    appEl.appendChild(gridHeading);
    const items = await api.getItems(libraryKey);
    appEl.appendChild(
      renderPosterGrid(items.Items, (item) => {
        window.location.hash = `#/item/${item.ratingKey}`;
      })
    );
  } catch (err) {
    appEl.innerHTML += `<p class="error">${err.message}</p>`;
  }
}

async function renderHomeShows() {
  setActiveNav('tvshows');
  clearAmbientBackground();
  appEl.innerHTML = '';
  await renderContinueWatching(appEl);
  try {
    const libraryKey = await getLibraryKey('show');
    await renderRecentlyAddedRow(appEl, libraryKey, (item) => {
      window.location.hash = `#/show/${item.ratingKey}`;
    });
    const gridHeading = document.createElement('div');
    gridHeading.className = 'section-heading';
    gridHeading.textContent = 'TV Shows';
    appEl.appendChild(gridHeading);
    const items = await api.getItems(libraryKey);
    appEl.appendChild(
      renderPosterGrid(items.Items, (item) => {
        window.location.hash = `#/show/${item.ratingKey}`;
      })
    );
  } catch (err) {
    appEl.innerHTML += `<p class="error">${err.message}</p>`;
  }
}

async function renderMovieDetailView(itemId) {
  setActiveNav(null);
  appEl.innerHTML = '<p>Loading...</p>';
  try {
    const item = await api.getItem(itemId);
    appEl.innerHTML = '';
    appEl.appendChild(
      renderMovieDetail(item, () => handlePlay(item.ratingKey, item.title), handleToggleWatched)
    );
    await renderRelatedSection(appEl, itemId);
  } catch (err) {
    appEl.innerHTML = `<p class="error">${err.message}</p>`;
  }
}

async function renderShowDetailView(showId) {
  setActiveNav(null);
  appEl.innerHTML = '<p>Loading...</p>';
  try {
    const show = await api.getItem(showId);
    const seasons = await api.getSeasons(showId);

    let onDeckEpisode = null;
    try {
      const onDeck = await api.getOnDeck();
      onDeckEpisode = onDeck.Items.find((i) => String(i.grandparentRatingKey) === String(showId));
    } catch {
      // Continue button is a nice-to-have; fall back to per-episode Play buttons only.
    }

    appEl.innerHTML = '';
    appEl.appendChild(
      renderShowHeader(
        show,
        onDeckEpisode,
        (ep) => handlePlay(ep.ratingKey, `${show.title} - ${ep.title}`),
        handleToggleWatched
      )
    );

    const seasonTabsContainer = document.createElement('div');
    const episodeListContainer = document.createElement('div');
    appEl.append(seasonTabsContainer, episodeListContainer);

    async function selectSeason(season) {
      seasonTabsContainer.innerHTML = '';
      seasonTabsContainer.appendChild(
        renderSeasonGrid(seasons.Items, season.ratingKey, selectSeason)
      );
      episodeListContainer.innerHTML = '<p>Loading episodes...</p>';
      const episodes = await api.getEpisodes(showId, season.ratingKey);
      episodeListContainer.innerHTML = '';
      episodeListContainer.appendChild(
        renderEpisodeGrid(
          episodes.Items,
          (ep) => handlePlay(ep.ratingKey, `${show.title} - ${ep.title}`),
          handleToggleWatched
        )
      );
    }

    if (seasons.Items.length > 0) {
      const startSeason =
        (onDeckEpisode &&
          seasons.Items.find((s) => s.index === onDeckEpisode.parentIndex)) ||
        seasons.Items[0];
      await selectSeason(startSeason);
    } else {
      episodeListContainer.innerHTML = '<p>No seasons found.</p>';
    }

    await renderRelatedSection(appEl, showId);
  } catch (err) {
    appEl.innerHTML = `<p class="error">${err.message}</p>`;
  }
}

function setupSidebarScanButtons() {
  document.querySelectorAll('.nav-scan-button').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const plexType = btn.dataset.scan;
      const label = plexType === 'movie' ? 'Movies' : 'TV Shows';
      btn.disabled = true;
      try {
        const libraryKey = await getLibraryKey(plexType);
        await api.scanLibrary(libraryKey);
        showToast(`${label} library scan started`);
      } catch (err) {
        showToast(err.message, true);
      } finally {
        btn.disabled = false;
      }
    });
  });
}

function router() {
  const hash = window.location.hash || '#/home/movies';
  const [, root, param] = hash.split('/');

  if (root === 'home' && param === 'tvshows') return renderHomeShows();
  if (root === 'home') return renderHomeMovies();
  if (root === 'item' && param) return renderMovieDetailView(param);
  if (root === 'show' && param) return renderShowDetailView(param);

  return renderHomeMovies();
}

window.addEventListener('hashchange', router);
window.addEventListener('DOMContentLoaded', () => {
  router();
  setupSidebarScanButtons();
});
