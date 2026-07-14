const appEl = document.getElementById('app');
const toastEl = document.getElementById('toast');
toastEl.setAttribute('role', 'status');
toastEl.setAttribute('aria-live', 'polite');

let toastTimeout;
let playbackRequestInFlight = false;
function showToast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.className = 'toast' + (isError ? ' error' : '');
  toastEl.setAttribute('role', isError ? 'alert' : 'status');
  toastEl.setAttribute('aria-live', isError ? 'assertive' : 'polite');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toastEl.classList.add('hidden'), 3000);
}

function showPlaybackTargetPicker(targets, defaultTargetId) {
  return new Promise((resolve) => {
    let selectedTarget = null;
    const dialog = document.createElement('dialog');
    dialog.className = 'target-picker';

    const heading = document.createElement('h2');
    heading.id = `target-picker-heading-${Date.now()}`;
    heading.textContent = 'Where should this play?';
    dialog.setAttribute('aria-labelledby', heading.id);
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Choose a paired device and media player.';
    const list = document.createElement('div');
    list.className = 'target-picker-list';

    for (const target of targets) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'target-option';
      button.disabled = !target.online;

      const title = document.createElement('span');
      title.className = 'target-option-title';
      title.textContent = target.name;
      const meta = document.createElement('span');
      meta.className = 'target-option-meta';
      const parts = [target.platform];
      const monitored = ['status.state', 'status.position', 'status.duration']
        .every((capability) => target.capabilities.includes(capability));
      if (!monitored) parts.push('Launch only');
      if (target.id === defaultTargetId) parts.push('Default');
      parts.push(target.online ? 'Online' : 'Offline');
      meta.textContent = parts.join(' · ');
      button.append(title, meta);
      button.addEventListener('click', () => {
        selectedTarget = target;
        dialog.close();
      });
      list.appendChild(button);
    }

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'icon-button-wide';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => dialog.close());

    dialog.append(heading, hint, list, cancel);
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(selectedTarget);
    }, { once: true });
    document.body.appendChild(dialog);
    dialog.showModal();
  });
}

async function selectPlaybackTarget() {
  const result = await api.getPlaybackTargets();
  const decision = MediaLauncherTargetSelection.decidePlaybackTarget(result);
  if (decision.action === 'error') throw new Error(decision.message);
  if (decision.action === 'target') return decision.target;
  return showPlaybackTargetPicker(result.targets, result.defaultPlaybackTargetId);
}

async function handlePlay(itemId, label) {
  if (playbackRequestInFlight) {
    showToast('A playback choice is already in progress');
    return;
  }
  playbackRequestInFlight = true;
  showToast('Finding available players...');
  try {
    const target = await selectPlaybackTarget();
    if (!target) {
      showToast('Playback cancelled');
      return;
    }
    showToast(`Starting "${label}" on ${target.name}...`);
    await api.play(itemId, target.id);
    showToast(`Now playing "${label}" on ${target.name}`);
  } catch (err) {
    showToast(err.message, true);
  } finally {
    playbackRequestInFlight = false;
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
async function loadLibraries() {
  if (!librariesCache) {
    const data = await api.getLibraries();
    // renderPosterGrid/detail views only know how to show movie/show-shaped Plex metadata -
    // other library types (music, photos, ...) are left out of the nav rather than showing a
    // broken page.
    librariesCache = data.Items.filter((section) => section.type === 'movie' || section.type === 'show');
  }
  return librariesCache;
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

async function renderLibraryHome(section) {
  setActiveNav(`library-${section.key}`);
  clearAmbientBackground();
  appEl.innerHTML = '';
  await renderContinueWatching(appEl);
  const targetRoute = section.type === 'show' ? 'show' : 'item';
  const onSelect = (item) => {
    window.location.hash = `#/${targetRoute}/${item.ratingKey}`;
  };
  try {
    await renderRecentlyAddedRow(appEl, section.key, onSelect);
    const gridHeading = document.createElement('div');
    gridHeading.className = 'section-heading';
    gridHeading.textContent = section.title;
    appEl.appendChild(gridHeading);
    const items = await api.getItems(section.key);
    appEl.appendChild(renderPosterGrid(items.Items, onSelect));
  } catch (err) {
    // appendChild, not `appEl.innerHTML += ...` - that would reserialize and reparse appEl's
    // existing children (e.g. an already-rendered Continue Watching row), silently detaching any
    // addEventListener listeners already attached to them.
    const errorEl = document.createElement('p');
    errorEl.className = 'error';
    errorEl.textContent = err.message;
    appEl.appendChild(errorEl);
  }
}

async function renderLibraryByKey(key) {
  const sections = await loadLibraries();
  const section = sections.find((s) => String(s.key) === String(key));
  if (!section) {
    appEl.innerHTML = '<p class="error">Library not found - it may have been removed from Plex.</p>';
    return;
  }
  return renderLibraryHome(section);
}

async function renderDefaultLibrary() {
  const sections = await loadLibraries();
  if (!sections.length) {
    appEl.innerHTML = '<p class="error">No movie or TV libraries found in Plex.</p>';
    return;
  }
  window.location.hash = `#/library/${sections[0].key}`; // triggers hashchange -> router()
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

function renderNavItem(section) {
  const div = document.createElement('div');
  div.className = 'nav-item';

  const a = document.createElement('a');
  a.href = `#/library/${section.key}`;
  a.dataset.nav = `library-${section.key}`;
  a.textContent = section.title;
  div.appendChild(a);

  const scanBtn = document.createElement('button');
  scanBtn.className = 'nav-scan-button';
  scanBtn.title = `Scan ${section.title} library`;
  scanBtn.textContent = '⟳';
  scanBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    scanBtn.disabled = true;
    try {
      await api.scanLibrary(section.key);
      showToast(`${section.title} library scan started`);
    } catch (err) {
      showToast(err.message, true);
    } finally {
      scanBtn.disabled = false;
    }
  });
  div.appendChild(scanBtn);

  return div;
}

// Rebuilds the sidebar from Plex's current library list - called at startup and again after
// Settings are saved, so newly-added/removed Plex libraries show up without a full page reload.
async function buildNav() {
  librariesCache = null; // force a fresh fetch, in case libraries changed since last load
  const sections = await loadLibraries();
  const container = document.getElementById('nav-libraries');
  container.innerHTML = '';
  for (const section of sections) {
    container.appendChild(renderNavItem(section));
  }
}

function router() {
  const hash = window.location.hash || '';
  const [, root, param] = hash.split('/');

  if (root === 'settings') return renderSettingsView();
  if (root === 'library' && param) return renderLibraryByKey(param);
  if (root === 'item' && param) return renderMovieDetailView(param);
  if (root === 'show' && param) return renderShowDetailView(param);

  return renderDefaultLibrary();
}

async function bootstrap() {
  let settings;
  try {
    settings = await api.getSettings();
  } catch {
    settings = null; // don't block startup on this check failing; routes will surface the real error
  }

  const incomplete =
    !settings ||
    !settings.plexUrl ||
    !settings.agents?.some((agent) =>
      agent.paired && agent.players?.some((player) =>
        player.available !== false && player.capabilities?.includes('play.file')
      )
    ) ||
    !settings.plexLinked;
  if (incomplete && window.location.hash !== '#/settings') {
    window.location.hash = '#/settings'; // triggers the hashchange listener below, which calls router()
    return;
  }

  try {
    await buildNav();
  } catch {
    // Nav is a nice-to-have at this point; routes will surface a clearer error if Plex is
    // unreachable.
  }
  router();
}

window.addEventListener('hashchange', router);
window.addEventListener('DOMContentLoaded', bootstrap);
