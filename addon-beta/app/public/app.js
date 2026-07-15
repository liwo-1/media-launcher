const mainEl = document.getElementById('app');
// The legacy Settings component refers to this global binding. Browsing routes use mainEl so a
// Settings render can be staged off-DOM and discarded if navigation makes it stale.
let appEl = mainEl;
const legacySettingsRenderer = renderSettingsView;
const toastEl = document.getElementById('toast');
const playbackControlsEl = document.getElementById('playback-controls') || (() => {
  // Tolerate one stale cached index.html response during an add-on upgrade.
  const container = document.createElement('section');
  container.id = 'playback-controls';
  container.className = 'playback-controls';
  container.setAttribute('aria-label', 'Active playback controls');
  container.hidden = true;
  document.body.appendChild(container);
  return container;
})();
const searchForm = document.getElementById('media-search-form');
const searchInput = document.getElementById('media-search-input');
toastEl.setAttribute('role', 'status');
toastEl.setAttribute('aria-live', 'polite');

let toastTimeout;
let playbackRequestInFlight = false;
let routeGeneration = 0;
let navigationGeneration = 0;
let routeController = null;
let activeSettingsContext = null;
let settingsRenderQueue = Promise.resolve();
let playbackReconcileTimer = null;
let playbackReconcileInFlight = false;
let playbackReconciliationStarted = false;
const playbackControlCards = new Map();
const dismissedPlaybackSessions = new Set();
const PLAYBACK_RECONCILE_INTERVAL_MS = 5000;

function showToast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.className = 'toast' + (isError ? ' error' : '');
  toastEl.setAttribute('role', isError ? 'alert' : 'status');
  toastEl.setAttribute('aria-live', isError ? 'assertive' : 'polite');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toastEl.classList.add('hidden'), 3000);
}

function startRoute() {
  routeGeneration += 1;
  if (routeController) routeController.abort();
  routeController = new AbortController();
  return {
    generation: routeGeneration,
    signal: routeController.signal,
  };
}

function routeIsCurrent(context) {
  return context.generation === routeGeneration && !context.signal.aborted;
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}

function createMessage(message, className = '') {
  const paragraph = document.createElement('p');
  if (className) paragraph.className = className;
  paragraph.textContent = message;
  return paragraph;
}

function showLoading(context, message = 'Loading…') {
  if (!routeIsCurrent(context)) return;
  mainEl.replaceChildren(createMessage(message));
}

function showRouteError(context, error) {
  if (!routeIsCurrent(context) || isAbortError(error)) return;
  clearAmbientBackground();
  const heading = createTextElement('h1', 'section-heading', 'Unable to load this page');
  heading.tabIndex = -1;
  mainEl.replaceChildren(
    heading,
    createMessage(error?.message || 'The page could not be loaded.', 'error')
  );
  updateDocumentTitle('Unable to load page');
  focusPrimaryHeading();
}

function focusPrimaryHeading() {
  const heading = mainEl.querySelector('h1');
  if (heading) heading.focus({ preventScroll: true });
}

function updateDocumentTitle(title) {
  document.title = title ? `${title} · Media Launcher` : 'Media Launcher';
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
      const capabilities = Array.isArray(target.capabilities) ? target.capabilities : [];
      const monitored = ['status.state', 'status.position', 'status.duration']
        .every((capability) => capabilities.includes(capability));
      if (!monitored) parts.push('Launch only');
      if (target.id === defaultTargetId) parts.push('Default');
      parts.push(target.online ? 'Online' : 'Offline');
      meta.textContent = parts.filter(Boolean).join(' · ');
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

function playbackAgentKey(target, playback) {
  return String(
    playback?.agentId || target?.agentId || playback?.targetId || target?.id || ''
  );
}

function playbackSessionToken(agentKey, sessionId) {
  return `${agentKey}:${sessionId}`;
}

function removePlaybackControlCard(agentKey, card = playbackControlCards.get(agentKey)) {
  if (!card) return;
  card.remove();
  if (playbackControlCards.get(agentKey) === card) playbackControlCards.delete(agentKey);
  playbackControlsEl.hidden = playbackControlCards.size === 0;
}

function showPlaybackSessionControls(label, target, playback) {
  const targetId = String(playback?.targetId || target?.id || '');
  const sessionId = typeof playback?.sessionId === 'string' ? playback.sessionId : '';
  const agentKey = playbackAgentKey(target, playback);
  removePlaybackControlCard(agentKey);

  const capabilities = new Set(Array.isArray(target?.capabilities) ? target.capabilities : []);
  const canPause = capabilities.has('control.pause');
  const canSeek = capabilities.has('control.seek');
  const canStop = capabilities.has('control.stop');
  if (!agentKey || !targetId || !sessionId || (!canPause && !canSeek && !canStop)) return;

  const targetName = String(target?.name || 'playback device');
  const sessionToken = playbackSessionToken(agentKey, sessionId);

  const card = document.createElement('article');
  card.className = 'playback-session-card';
  card.dataset.agentKey = agentKey;
  card.dataset.targetId = targetId;
  card.dataset.sessionId = sessionId;
  card.setAttribute('aria-label', `Playback controls for ${label} on ${targetName}`);

  const headingRow = document.createElement('div');
  headingRow.className = 'playback-session-heading';
  const identity = document.createElement('div');
  const title = document.createElement('strong');
  title.className = 'playback-session-title';
  title.textContent = label;
  const status = document.createElement('span');
  status.className = 'playback-session-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent = `Playing on ${targetName}`;
  identity.append(title, status);
  const dismissButton = document.createElement('button');
  dismissButton.type = 'button';
  dismissButton.className = 'playback-dismiss';
  dismissButton.setAttribute('aria-label', `Dismiss controls for ${label}`);
  dismissButton.title = 'Dismiss controls (playback continues)';
  dismissButton.textContent = '×';
  dismissButton.addEventListener('click', () => {
    dismissedPlaybackSessions.add(sessionToken);
    removePlaybackControlCard(agentKey, card);
  });
  headingRow.append(identity, dismissButton);

  const actions = document.createElement('div');
  actions.className = 'playback-control-actions';
  const requestControls = [];
  let requestInFlight = false;
  async function sendControl(action, positionMs) {
    if (requestInFlight || !card.isConnected) return null;
    requestInFlight = true;
    for (const control of requestControls) control.disabled = true;
    try {
      return await api.controlPlaybackSession(sessionId, { targetId, action, positionMs });
    } catch (error) {
      showToast(error.message, true);
      return null;
    } finally {
      requestInFlight = false;
      if (card.isConnected) {
        for (const control of requestControls) control.disabled = false;
      }
    }
  }

  if (canPause) {
    let paused = false;
    const pauseButton = document.createElement('button');
    pauseButton.type = 'button';
    pauseButton.className = 'icon-button-wide';
    pauseButton.textContent = '⏸ Pause';
    pauseButton.addEventListener('click', async () => {
      const action = paused ? 'resume' : 'pause';
      const result = await sendControl(action);
      if (!result || !pauseButton.isConnected) return;
      paused = !paused;
      pauseButton.textContent = paused ? '▶ Resume' : '⏸ Pause';
      status.textContent = `${paused ? 'Paused' : 'Playing'} on ${targetName}`;
    });
    requestControls.push(pauseButton);
    actions.appendChild(pauseButton);
  }

  if (canSeek) {
    const seekGroup = document.createElement('div');
    seekGroup.className = 'playback-seek-group';
    const seekLabel = document.createElement('label');
    seekLabel.textContent = 'Seek to (seconds)';
    const seekInput = document.createElement('input');
    seekInput.type = 'number';
    seekInput.className = 'playback-seek-input';
    seekInput.min = '0';
    seekInput.max = '604800';
    seekInput.step = '1';
    seekInput.inputMode = 'numeric';
    seekInput.placeholder = 'Seconds';
    seekLabel.appendChild(seekInput);
    const seekButton = document.createElement('button');
    seekButton.type = 'button';
    seekButton.className = 'icon-button-wide';
    seekButton.textContent = 'Seek';
    async function seek() {
      const value = seekInput.value.trim();
      const seconds = Number(value);
      if (!value || !Number.isFinite(seconds) || seconds < 0 || seconds > 604800) {
        showToast('Enter a seek position from 0 to 604800 seconds', true);
        seekInput.focus();
        return;
      }
      const positionMs = Math.round(seconds * 1000);
      const result = await sendControl('seek', positionMs);
      if (result && card.isConnected) showToast(`Seeking "${label}" to ${seconds} seconds`);
    }
    seekButton.addEventListener('click', seek);
    seekInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (!seekButton.disabled) seekButton.click();
    });
    requestControls.push(seekInput, seekButton);
    seekGroup.append(seekLabel, seekButton);
    actions.appendChild(seekGroup);
  }

  if (canStop) {
    const stopButton = document.createElement('button');
    stopButton.type = 'button';
    stopButton.className = 'icon-button-wide danger-button';
    stopButton.textContent = '■ Stop';
    stopButton.addEventListener('click', async () => {
      const result = await sendControl('stop');
      if (!result || !card.isConnected) return;
      dismissedPlaybackSessions.add(sessionToken);
      removePlaybackControlCard(agentKey, card);
      showToast(`Stopped "${label}" on ${targetName}`);
    });
    requestControls.push(stopButton);
    actions.appendChild(stopButton);
  }

  card.append(headingRow, actions);
  playbackControlCards.set(agentKey, card);
  playbackControlsEl.appendChild(card);
  playbackControlsEl.hidden = false;
}

function playbackTargetFromSession(session) {
  const names = [session.agentName, session.playerName]
    .filter((value) => typeof value === 'string' && value.trim());
  return {
    id: String(session.targetId || ''),
    agentId: String(session.agentId || ''),
    name: names.join(' — ') || 'Playback device',
    capabilities: Array.isArray(session.capabilities) ? session.capabilities : [],
  };
}

function updatePlaybackControlCard(card, session, target) {
  const title = card.querySelector('.playback-session-title');
  if (title) title.textContent = String(session.title || 'Untitled media');
  const status = card.querySelector('.playback-session-status');
  if (!status) return;
  const stateLabels = {
    paused: 'Paused',
    playing: 'Playing',
    starting: 'Starting',
    stopping: 'Stopping',
  };
  status.textContent = `${stateLabels[session.state] || 'Playing'} on ${target.name}`;
}

function reconcilePlaybackSessionCards(payload) {
  const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
  const activeTokens = new Set();
  const activeCardKeys = new Set();

  for (const session of sessions) {
    const target = playbackTargetFromSession(session || {});
    const sessionId = typeof session?.sessionId === 'string' ? session.sessionId : '';
    const agentKey = playbackAgentKey(target, session);
    if (!agentKey || !target.id || !sessionId) continue;

    const token = playbackSessionToken(agentKey, sessionId);
    activeTokens.add(token);
    const capabilities = new Set(target.capabilities);
    const canControl = ['control.pause', 'control.seek', 'control.stop']
      .some((capability) => capabilities.has(capability));
    if (!canControl || dismissedPlaybackSessions.has(token)) continue;

    activeCardKeys.add(agentKey);
    let card = playbackControlCards.get(agentKey);
    if (
      !card ||
      card.dataset.sessionId !== sessionId ||
      card.dataset.targetId !== target.id
    ) {
      showPlaybackSessionControls(
        String(session.title || 'Untitled media'),
        target,
        session
      );
      card = playbackControlCards.get(agentKey);
    }
    if (card) updatePlaybackControlCard(card, session, target);
  }

  for (const [agentKey, card] of [...playbackControlCards.entries()]) {
    if (!activeCardKeys.has(agentKey)) removePlaybackControlCard(agentKey, card);
  }
  for (const token of [...dismissedPlaybackSessions]) {
    if (!activeTokens.has(token)) dismissedPlaybackSessions.delete(token);
  }
}

async function refreshPlaybackSessionCards() {
  if (playbackReconcileInFlight) return;
  playbackReconcileInFlight = true;
  try {
    reconcilePlaybackSessionCards(await api.getPlaybackSessions());
  } catch {
    // Keep the last known controls during a transient add-on or network failure.
  } finally {
    playbackReconcileInFlight = false;
  }
}

function schedulePlaybackSessionReconciliation() {
  clearTimeout(playbackReconcileTimer);
  playbackReconcileTimer = setTimeout(async () => {
    await refreshPlaybackSessionCards();
    schedulePlaybackSessionReconciliation();
  }, PLAYBACK_RECONCILE_INTERVAL_MS);
}

function startPlaybackSessionReconciliation() {
  if (playbackReconciliationStarted) return;
  playbackReconciliationStarted = true;
  refreshPlaybackSessionCards().finally(schedulePlaybackSessionReconciliation);
}

async function handlePlay(itemId, label) {
  if (playbackRequestInFlight) {
    showToast('A playback choice is already in progress');
    return;
  }
  playbackRequestInFlight = true;
  showToast('Finding available players…');
  try {
    const target = await selectPlaybackTarget();
    if (!target) {
      showToast('Playback cancelled');
      return;
    }
    showToast(`Starting "${label}" on ${target.name}…`);
    const playback = await api.play(itemId, target.id);
    showPlaybackSessionControls(label, target, playback);
    showToast(`Now playing "${label}" on ${target.name}`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    playbackRequestInFlight = false;
  }
}

async function handleToggleWatched(button, item) {
  const nextWatched = !item.watched;
  button.disabled = true;
  try {
    await api.setWatched(item.id, nextWatched);
    item.watched = nextWatched;
    setWatchedButtonState(button, item);
    showToast(nextWatched ? 'Marked watched' : 'Marked unwatched');
    return true;
  } catch (error) {
    showToast(error.message, true);
    return false;
  } finally {
    button.disabled = false;
  }
}

function setActiveNav(section) {
  document.querySelectorAll('#nav a').forEach((anchor) => {
    const active = anchor.dataset.nav === section;
    anchor.classList.toggle('active', active);
    if (active) anchor.setAttribute('aria-current', 'page');
    else anchor.removeAttribute('aria-current');
  });
}

function decodeRoutePart(value) {
  try {
    return decodeURIComponent(value || '');
  } catch {
    return '';
  }
}

function parseRoute() {
  const hash = (window.location.hash || '').replace(/^#\/?/, '');
  const [root = '', parameter = ''] = hash.split('/');
  return { root, parameter: decodeRoutePart(parameter) };
}

async function loadLibraries(signal) {
  const data = await api.getLibraries(signal);
  return (Array.isArray(data?.items) ? data.items : [])
    .filter((library) => library.kind === 'movie' || library.kind === 'series');
}

function goToItem(item) {
  window.location.hash = MediaLauncherMediaModel.routeForItem(item);
}

function appendShelf(container, title, entries) {
  if (!entries.length) return;
  const section = document.createElement('section');
  section.appendChild(createTextElement('h2', 'section-heading', title));
  const row = document.createElement('div');
  row.className = 'continue-row';
  for (const entry of entries) {
    const item = entry.item || entry;
    const presentation = entry.item ? { title: entry.title, subtitle: entry.subtitle } : null;
    row.appendChild(renderPosterCard(item, goToItem, presentation));
  }
  section.appendChild(row);
  container.appendChild(section);
}

function appendRelatedSection(container, items) {
  appendShelf(container, 'Related', items);
}

function createPageIdentity(title) {
  const heading = createTextElement('h1', 'visually-hidden', title);
  heading.tabIndex = -1;
  return heading;
}

async function renderLibraryHome(library, context) {
  setActiveNav(`library-${library.id}`);
  clearAmbientBackground();
  showLoading(context, `Loading ${library.title}…`);

  const optional = (promise) => promise.catch((error) => {
    if (isAbortError(error)) throw error;
    return { items: [] };
  });
  const [continueData, recentData, itemData] = await Promise.all([
    optional(api.getContinueWatching(context.signal)),
    optional(api.getRecentlyAdded(library.id, context.signal)),
    api.getLibraryItems(library.id, context.signal),
  ]);
  if (!routeIsCurrent(context)) return;

  const content = document.createDocumentFragment();
  content.appendChild(createPageIdentity(library.title));
  appendShelf(content, 'Continue Watching', Array.isArray(continueData.items) ? continueData.items : []);
  const recent = MediaLauncherMediaModel.recentPresentation(recentData.items);
  appendShelf(content, 'Recently Added', recent);

  const librarySection = document.createElement('section');
  librarySection.appendChild(createTextElement('h2', 'section-heading', library.title));
  const items = Array.isArray(itemData?.items) ? itemData.items : [];
  if (items.length) librarySection.appendChild(renderPosterGrid(items, goToItem));
  else librarySection.appendChild(createMessage(`No titles found in ${library.title}.`, 'empty-state'));
  content.appendChild(librarySection);

  mainEl.replaceChildren(content);
  updateDocumentTitle(library.title);
  focusPrimaryHeading();
}

async function renderLibraryById(id, context) {
  const libraries = await loadLibraries(context.signal);
  if (!routeIsCurrent(context)) return;
  const library = libraries.find((candidate) => String(candidate.id) === String(id));
  if (!library) throw new Error('Library not found. It may have been removed from the media server.');
  await renderLibraryHome(library, context);
}

async function renderDefaultLibrary(context) {
  const libraries = await loadLibraries(context.signal);
  if (!routeIsCurrent(context)) return;
  if (!libraries.length) {
    clearAmbientBackground();
    const heading = createTextElement('h1', 'section-heading', 'No libraries available');
    heading.tabIndex = -1;
    mainEl.replaceChildren(
      heading,
      createMessage('No movie or TV libraries found on the media server.', 'empty-state')
    );
    updateDocumentTitle('No libraries');
    focusPrimaryHeading();
    return;
  }
  window.location.hash = `#/library/${encodeURIComponent(libraries[0].id)}`;
}

async function renderSearchResults(query, context) {
  setActiveNav(null);
  clearAmbientBackground();
  searchInput.value = query;
  showLoading(context, `Searching for ${query}…`);
  const data = await api.searchMedia(query, context.signal);
  if (!routeIsCurrent(context)) return;

  const heading = createTextElement('h1', 'section-heading', `Search results for “${query}”`);
  heading.tabIndex = -1;
  const items = Array.isArray(data?.items) ? data.items : [];
  const content = [heading];
  if (items.length) content.push(renderPosterGrid(items, goToItem));
  else content.push(createMessage(`No results found for “${query}”.`, 'empty-state'));
  mainEl.replaceChildren(...content);
  updateDocumentTitle(`Search: ${query}`);
  focusPrimaryHeading();
}

async function renderMovieDetailView(itemId, context) {
  setActiveNav(null);
  showLoading(context);
  const [item, relatedData] = await Promise.all([
    api.getItem(itemId, context.signal),
    api.getRelated(itemId, context.signal).catch((error) => {
      if (isAbortError(error)) throw error;
      return { items: [] };
    }),
  ]);
  if (!routeIsCurrent(context)) return;
  if (item.kind === 'series') {
    window.location.hash = `#/series/${encodeURIComponent(item.id)}`;
    return;
  }

  const content = document.createDocumentFragment();
  content.appendChild(renderMovieDetail(
    item,
    () => handlePlay(item.id, item.title),
    handleToggleWatched
  ));
  appendRelatedSection(content, Array.isArray(relatedData.items) ? relatedData.items : []);
  mainEl.replaceChildren(content);
  updateDocumentTitle(item.title);
  focusPrimaryHeading();
}

async function renderSeriesDetailView(seriesId, context) {
  setActiveNav(null);
  showLoading(context);
  const optional = (promise, fallback) => promise.catch((error) => {
    if (isAbortError(error)) throw error;
    return fallback;
  });
  const [series, seasonData, continueData, relatedData] = await Promise.all([
    api.getItem(seriesId, context.signal),
    api.getSeasons(seriesId, context.signal),
    optional(api.getContinueWatching(context.signal), { items: [] }),
    optional(api.getRelated(seriesId, context.signal), { items: [] }),
  ]);
  if (!routeIsCurrent(context)) return;

  const continueItems = Array.isArray(continueData.items) ? continueData.items : [];
  const nextEpisode = continueItems.find(
    (item) => item.kind === 'episode' &&
      String(item.hierarchy?.seriesId || '') === String(seriesId)
  ) || null;

  function updateSeriesProgress(header) {
    const progress = header.querySelector('.progress-line');
    if (!progress) return;
    const episodes = Number(series.counts?.episodes || 0);
    const watched = Number(series.counts?.watchedEpisodes || 0);
    progress.textContent = `${watched} of ${episodes} episodes watched`;
  }
  async function toggleSeriesWatched(button, item) {
    const changed = await handleToggleWatched(button, item);
    if (!changed) return;
    series.counts.watchedEpisodes = series.watched ? Number(series.counts.episodes || 0) : 0;
    updateSeriesProgress(seriesHeader);
  }

  const content = document.createDocumentFragment();
  const seriesHeader = renderShowHeader(
    series,
    nextEpisode,
    (episode) => handlePlay(episode.id, `${series.title} - ${episode.title}`),
    toggleSeriesWatched
  );
  content.appendChild(seriesHeader);
  const seasonTabsContainer = document.createElement('div');
  const episodeListContainer = document.createElement('div');
  episodeListContainer.id = 'season-episode-panel';
  content.append(seasonTabsContainer, episodeListContainer);
  appendRelatedSection(content, Array.isArray(relatedData.items) ? relatedData.items : []);
  mainEl.replaceChildren(content);
  updateDocumentTitle(series.title);
  focusPrimaryHeading();

  const seasons = Array.isArray(seasonData.items) ? seasonData.items : [];
  let seasonRequest = 0;
  async function selectSeason(season) {
    const request = ++seasonRequest;
    const restoreTabFocus = seasonTabsContainer.contains(document.activeElement);
    const seasonGrid = renderSeasonGrid(seasons, season.id, selectSeason);
    seasonTabsContainer.replaceChildren(seasonGrid);
    const selectedTab = seasonGrid.querySelector('[role="tab"][aria-selected="true"]');
    episodeListContainer.setAttribute('role', 'tabpanel');
    if (selectedTab) episodeListContainer.setAttribute('aria-labelledby', selectedTab.id);
    if (restoreTabFocus && selectedTab) selectedTab.focus({ preventScroll: true });
    episodeListContainer.setAttribute('aria-busy', 'true');
    episodeListContainer.replaceChildren(createMessage('Loading episodes…'));
    try {
      const episodeData = await api.getEpisodes(seriesId, season.id, context.signal);
      if (!routeIsCurrent(context) || request !== seasonRequest) return;
      const episodes = Array.isArray(episodeData.items) ? episodeData.items : [];
      episodeListContainer.removeAttribute('aria-busy');
      episodeListContainer.replaceChildren(renderEpisodeGrid(
        episodes,
        (episode) => handlePlay(episode.id, `${series.title} - ${episode.title}`),
        async (button, episode) => {
          const previous = episode.watched;
          const changed = await handleToggleWatched(button, episode);
          if (!changed || previous === episode.watched) return;
          const current = Number(series.counts?.watchedEpisodes || 0);
          const maximum = Number(series.counts?.episodes || 0);
          series.counts.watchedEpisodes = Math.max(
            0,
            Math.min(maximum, current + (episode.watched ? 1 : -1))
          );
          updateSeriesProgress(seriesHeader);
        }
      ));
    } catch (error) {
      if (!routeIsCurrent(context) || request !== seasonRequest || isAbortError(error)) return;
      episodeListContainer.removeAttribute('aria-busy');
      episodeListContainer.replaceChildren(createMessage(error.message, 'error'));
    }
  }

  if (!seasons.length) {
    episodeListContainer.replaceChildren(createMessage('No seasons found.', 'empty-state'));
    return;
  }
  const nextSeasonId = nextEpisode?.hierarchy?.seasonId;
  const nextSeasonNumber = nextEpisode?.hierarchy?.seasonNumber;
  const startSeason = seasons.find((season) =>
    (nextSeasonId && String(season.id) === String(nextSeasonId)) ||
    (nextSeasonNumber && Number(season.hierarchy?.seasonNumber) === Number(nextSeasonNumber))
  ) || seasons[0];
  selectSeason(startSeason);
}

function renderNavItem(library) {
  const item = document.createElement('div');
  item.className = 'nav-item';

  const link = document.createElement('a');
  link.href = `#/library/${encodeURIComponent(library.id)}`;
  link.dataset.nav = `library-${library.id}`;
  link.textContent = library.title;
  item.appendChild(link);

  if (library.canScan) {
    const scanButton = document.createElement('button');
    scanButton.type = 'button';
    scanButton.className = 'nav-scan-button';
    scanButton.setAttribute('aria-label', `Scan ${library.title} library`);
    scanButton.textContent = '⟳';
    scanButton.addEventListener('click', async (event) => {
      event.preventDefault();
      scanButton.disabled = true;
      try {
        await api.scanLibrary(library.id);
        showToast(`${library.title} library scan started`);
      } catch (error) {
        showToast(error.message, true);
      } finally {
        scanButton.disabled = false;
      }
    });
    item.appendChild(scanButton);
  }
  return item;
}

async function buildNav(context = null) {
  const generation = ++navigationGeneration;
  const libraries = await loadLibraries(context?.signal);
  if (generation !== navigationGeneration) return;
  if (context && !routeIsCurrent(context)) return;
  const container = document.getElementById('nav-libraries');
  container.replaceChildren(...libraries.map(renderNavItem));
}

async function refreshNavIfMediaReady() {
  const status = await api.getBootstrap();
  if (status?.mediaServer?.ready) await buildNav();
  else {
    navigationGeneration += 1;
    document.getElementById('nav-libraries')?.replaceChildren();
  }
}

function guardedSettingsRenderer() {
  const requestedContext = activeSettingsContext;
  const render = async () => {
    if (
      !requestedContext ||
      !routeIsCurrent(requestedContext) ||
      parseRoute().root !== 'settings'
    ) return;

    const staging = document.createElement('div');
    appEl = staging;
    try {
      await legacySettingsRenderer();
    } finally {
      appEl = mainEl;
    }
    if (!routeIsCurrent(requestedContext) || parseRoute().root !== 'settings') return;

    let heading = staging.querySelector('h1');
    if (!heading) {
      heading = createTextElement('h1', 'visually-hidden', 'Settings');
      heading.tabIndex = -1;
      const settingsView = staging.querySelector('.settings-view');
      if (settingsView) settingsView.prepend(heading);
      else staging.prepend(heading);
    }
    for (const status of staging.querySelectorAll('.link-status')) {
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
    }
    mainEl.replaceChildren(...staging.childNodes);
    focusPrimaryHeading();
    refreshNavIfMediaReady().catch(() => {});
  };
  settingsRenderQueue = settingsRenderQueue.then(render, render);
  return settingsRenderQueue;
}

// Calls made by Settings event handlers (pairing retries/removal) use the same detached, guarded
// renderer as router-driven navigation without modifying the legacy component itself.
renderSettingsView = guardedSettingsRenderer;

async function router() {
  const context = startRoute();
  const { root, parameter } = parseRoute();
  if (root !== 'settings') activeSettingsContext = null;
  try {
    if (root === 'settings') {
      activeSettingsContext = context;
      setActiveNav('settings');
      clearAmbientBackground();
      showLoading(context, 'Loading settings…');
      updateDocumentTitle('Settings');
      await renderSettingsView();
      return;
    }
    if (root === 'library' && parameter) return await renderLibraryById(parameter, context);
    if (root === 'item' && parameter) return await renderMovieDetailView(parameter, context);
    if ((root === 'series' || root === 'show') && parameter) {
      return await renderSeriesDetailView(parameter, context);
    }
    if (root === 'search' && parameter) return await renderSearchResults(parameter, context);
    return await renderDefaultLibrary(context);
  } catch (error) {
    showRouteError(context, error);
  }
}

async function bootstrap() {
  let status;
  try {
    status = await api.getBootstrap();
  } catch (error) {
    const context = startRoute();
    showRouteError(context, error);
    return;
  }

  const mediaServer = status?.mediaServer || {};
  const playback = status?.playback || {};
  const incomplete = !mediaServer.configured || !mediaServer.authenticated ||
    !mediaServer.ready || !playback.hasTargets;
  if (incomplete && parseRoute().root !== 'settings') {
    window.location.hash = '#/settings';
    return;
  }

  if (mediaServer.ready) {
    try {
      await buildNav();
    } catch {
      // The active route provides the actionable provider error.
    }
  }
  router();
}

searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const query = searchInput.value.trim();
  if (!query) {
    showToast('Enter a title to search for', true);
    searchInput.focus();
    return;
  }
  const nextHash = `#/search/${encodeURIComponent(query)}`;
  if (window.location.hash === nextHash) router();
  else window.location.hash = nextHash;
});

window.addEventListener('hashchange', () => { router(); });
window.addEventListener('media-launcher:provider-linked', () => {
  refreshNavIfMediaReady().catch(() => {});
});
window.addEventListener('DOMContentLoaded', () => {
  bootstrap();
  startPlaybackSessionReconciliation();
});
