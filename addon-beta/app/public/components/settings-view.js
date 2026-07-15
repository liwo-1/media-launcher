function createLiveStatus(message, extraClass = '') {
  const status = document.createElement('p');
  status.className = `link-status${extraClass ? ` ${extraClass}` : ''}`;
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent = message;
  return status;
}

async function refreshSettingsNavigation() {
  const container = document.getElementById('nav-libraries');
  try {
    const bootstrapState = await api.getBootstrap();
    if (bootstrapState?.mediaServer?.ready) await buildNav();
    else container?.replaceChildren();
  } catch {
    // Settings already surfaces the actionable error. Leave navigation refresh best-effort.
  }
}

function createMediaServerSection(settings, onAccountChanged = () => {}) {
  const mediaServer = settings.mediaServer && typeof settings.mediaServer === 'object'
    ? settings.mediaServer
    : {};
  const mediaAccounts = settings.mediaAccounts && typeof settings.mediaAccounts === 'object'
    ? settings.mediaAccounts
    : {};
  let activeProvider = mediaServer.provider || settings.mediaProvider || 'plex';
  const initialProvider = mediaServer.provider || settings.mediaProvider || 'plex';
  const section = document.createElement('section');
  section.className = 'settings-section';

  const heading = document.createElement('h2');
  heading.textContent = 'Media Server';

  const providerLabel = document.createElement('label');
  providerLabel.textContent = 'Media provider';
  const providerSelect = document.createElement('select');
  providerSelect.setAttribute('aria-label', 'Media provider');
  for (const [value, label] of [['plex', 'Plex'], ['jellyfin', 'Jellyfin']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    option.selected = value === initialProvider;
    providerSelect.appendChild(option);
  }
  providerSelect.disabled = settings.mediaProviderEnvironmentManaged === true;
  if (providerSelect.disabled) {
    providerSelect.title = 'The active provider is managed by MEDIA_PROVIDER';
  }
  providerLabel.appendChild(providerSelect);

  const plexUrlLabel = document.createElement('label');
  plexUrlLabel.textContent = 'Plex server URL';
  const plexUrlInput = document.createElement('input');
  plexUrlInput.type = 'url';
  plexUrlInput.autocomplete = 'url';
  plexUrlInput.maxLength = 2048;
  plexUrlInput.placeholder = 'http://192.168.1.x:32400';
  plexUrlInput.value = mediaAccounts.plex?.urlEnvironmentManaged
    ? mediaAccounts.plex.serverUrl || ''
    : settings.plexUrl || mediaAccounts.plex?.serverUrl ||
      (mediaServer.provider === 'plex' ? mediaServer.serverUrl : '') || '';
  plexUrlLabel.appendChild(plexUrlInput);

  const jellyfinUrlLabel = document.createElement('label');
  jellyfinUrlLabel.textContent = 'Jellyfin server URL';
  const jellyfinUrlInput = document.createElement('input');
  jellyfinUrlInput.type = 'url';
  jellyfinUrlInput.autocomplete = 'url';
  jellyfinUrlInput.maxLength = 2048;
  jellyfinUrlInput.placeholder = 'http://192.168.1.x:8096';
  jellyfinUrlInput.value = mediaAccounts.jellyfin?.urlEnvironmentManaged
    ? mediaAccounts.jellyfin.serverUrl || ''
    : settings.jellyfinUrl || mediaAccounts.jellyfin?.serverUrl ||
      (mediaServer.provider === 'jellyfin' ? mediaServer.serverUrl : '') || '';
  jellyfinUrlLabel.appendChild(jellyfinUrlInput);

  const providerHint = document.createElement('p');
  providerHint.className = 'hint';
  const accountHost = document.createElement('div');
  accountHost.className = 'media-server-account';
  let accountGeneration = 0;

  const accountState = {
    plex: {
      linked: Boolean(mediaAccounts.plex?.linked || settings.plexLinked ||
        (mediaServer.provider === 'plex' && mediaServer.linked)),
      accountDisplayName: mediaAccounts.plex?.accountDisplayName ||
        (mediaServer.provider === 'plex' ? mediaServer.accountDisplayName || '' : ''),
      serverName: mediaAccounts.plex?.serverName ||
        (mediaServer.provider === 'plex' ? mediaServer.serverName || '' : ''),
      environmentManaged: mediaAccounts.plex?.environmentManaged === true ||
        (mediaServer.provider === 'plex' && mediaServer.environmentManaged === true),
      urlEnvironmentManaged: mediaAccounts.plex?.urlEnvironmentManaged === true,
      credentialsEnvironmentManaged:
        mediaAccounts.plex?.credentialsEnvironmentManaged === true,
      isAdministrator: false,
    },
    jellyfin: {
      linked: Boolean(mediaAccounts.jellyfin?.linked ||
        (mediaServer.provider === 'jellyfin' && mediaServer.linked)),
      accountDisplayName: mediaAccounts.jellyfin?.accountDisplayName ||
        (mediaServer.provider === 'jellyfin'
        ? mediaServer.accountDisplayName || ''
        : ''),
      serverName: mediaAccounts.jellyfin?.serverName ||
        (mediaServer.provider === 'jellyfin' ? mediaServer.serverName || '' : ''),
      environmentManaged: mediaAccounts.jellyfin?.environmentManaged === true ||
        (mediaServer.provider === 'jellyfin' && mediaServer.environmentManaged === true),
      urlEnvironmentManaged: mediaAccounts.jellyfin?.urlEnvironmentManaged === true,
      credentialsEnvironmentManaged:
        mediaAccounts.jellyfin?.credentialsEnvironmentManaged === true,
      isAdministrator: mediaAccounts.jellyfin?.isAdministrator === true ||
        (mediaServer.provider === 'jellyfin' && mediaServer.isAdministrator === true),
    },
  };

  function renderProviderHint() {
    const selectedLabel = providerSelect.value === 'jellyfin' ? 'Jellyfin' : 'Plex';
    providerHint.textContent = providerSelect.disabled
      ? `${selectedLabel} is managed by the MEDIA_PROVIDER environment variable.`
      : providerSelect.value === activeProvider
      ? `${selectedLabel} is the active media provider.`
      : `Save to make ${selectedLabel} the active media provider.`;
  }

  function selectedServerUrl() {
    return providerSelect.value === 'jellyfin'
      ? jellyfinUrlInput.value.trim()
      : plexUrlInput.value.trim();
  }

  function renderPlexPin(pin) {
    const generation = ++accountGeneration;
    const expiresInSeconds = Number.isFinite(Number(pin.expiresIn))
      ? Math.min(1800, Math.max(30, Number(pin.expiresIn)))
      : 600;
    const expiresAt = Date.now() + expiresInSeconds * 1000;
    const accountHeading = document.createElement('h3');
    accountHeading.textContent = 'Plex account';
    const instructions = document.createElement('p');
    instructions.append('Open ');
    const link = document.createElement('a');
    link.href = 'https://plex.tv/link';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'plex.tv/link';
    instructions.append(link, ' and enter this code:');
    const code = document.createElement('div');
    code.className = 'link-code';
    code.textContent = String(pin.code || '');
    const status = createLiveStatus('Waiting for confirmation…');
    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'icon-button-wide';
    cancelButton.textContent = 'Cancel';
    cancelButton.addEventListener('click', () => renderAccount());
    const retryButton = document.createElement('button');
    retryButton.type = 'button';
    retryButton.className = 'play-button';
    retryButton.textContent = 'Request a new code';
    retryButton.hidden = true;
    let activationPending = false;

    async function completePlexActivation() {
      const providerWasDisabled = providerSelect.disabled;
      providerSelect.disabled = true;
      try {
        await api.saveSettings({ mediaProvider: 'plex' });
      } finally {
        if (providerSelect.isConnected) providerSelect.disabled = providerWasDisabled;
      }
      if (
        generation !== accountGeneration ||
        providerSelect.value !== 'plex' ||
        !accountHost.isConnected
      ) return;
      accountState.plex.linked = true;
      activeProvider = 'plex';
      window.dispatchEvent(new Event('media-launcher:provider-linked'));
      Promise.resolve(onAccountChanged()).catch(() => {});
      renderProviderHint();
      showToast('Plex account linked');
      renderAccount();
    }

    retryButton.addEventListener('click', async () => {
      retryButton.disabled = true;
      status.textContent = activationPending
        ? 'Finishing Plex setup…'
        : 'Requesting a new Plex link code…';
      try {
        if (activationPending) {
          await completePlexActivation();
          return;
        }
        const nextPin = await api.requestPlexPin();
        if (generation !== accountGeneration || !accountHost.isConnected) return;
        renderPlexPin(nextPin);
      } catch (err) {
        if (generation !== accountGeneration || !accountHost.isConnected) return;
        status.textContent = err.message;
        retryButton.disabled = false;
      }
    });
    accountHost.replaceChildren(
      accountHeading,
      instructions,
      code,
      status,
      retryButton,
      cancelButton
    );

    function expirePin() {
      status.textContent = 'This Plex link code expired.';
      retryButton.hidden = false;
      retryButton.focus();
    }

    async function poll() {
      if (
        generation !== accountGeneration ||
        providerSelect.value !== 'plex' ||
        !accountHost.isConnected
      ) return;
      if (Date.now() >= expiresAt) {
        expirePin();
        return;
      }
      try {
        const result = await api.checkPlexPin(pin.id);
        if (generation !== accountGeneration || !accountHost.isConnected) return;
        if (result.linked) {
          activationPending = true;
          retryButton.textContent = 'Retry activation';
          status.textContent = 'Plex linked. Finishing setup…';
          try {
            await completePlexActivation();
          } catch (err) {
            if (generation !== accountGeneration || !accountHost.isConnected) return;
            status.textContent = `Plex linked, but setup could not finish: ${err.message}`;
            retryButton.hidden = false;
            retryButton.disabled = false;
          }
          return;
        }
      } catch (err) {
        if (generation !== accountGeneration || !accountHost.isConnected) return;
        status.textContent = err.message;
      }
      if (generation === accountGeneration && accountHost.isConnected) {
        setTimeout(poll, Math.min(2000, Math.max(1, expiresAt - Date.now())));
      }
    }
    poll();
  }

  function renderLinkedAccount(provider, state, accountHeading) {
    const label = provider === 'jellyfin' ? 'Jellyfin' : 'Plex';
    const identity = state.accountDisplayName ? ` as ${state.accountDisplayName}` : '';
    const status = createLiveStatus(`✓ Linked${identity}`, 'linked');
    const details = document.createElement('p');
    details.className = 'hint';
    if (provider === 'jellyfin') {
      const server = state.serverName ? ` on ${state.serverName}` : '';
      details.textContent = state.isAdministrator
        ? `Administrator account${server}. Library discovery and scanning are available.`
        : `Account${server}. Browsing and playback are available; server path discovery and scanning require a Jellyfin administrator.`;
    } else {
      details.textContent = 'Plex authentication is stored privately by the add-on.';
    }

    const unlinkButton = document.createElement('button');
    unlinkButton.type = 'button';
    unlinkButton.className = 'icon-button-wide danger-button';
    unlinkButton.textContent = `Unlink ${label}`;
    unlinkButton.disabled = state.credentialsEnvironmentManaged;
    if (state.credentialsEnvironmentManaged) {
      unlinkButton.title = `${label} authentication is managed by environment variables`;
      details.textContent += ' Authentication is managed by environment variables.';
    } else if (state.urlEnvironmentManaged) {
      details.textContent += ' The server URL is managed by an environment variable.';
    }
    unlinkButton.addEventListener('click', async () => {
      if (!window.confirm(`Unlink ${label}? Browsing and playback will stop until it is linked again.`)) {
        return;
      }
      unlinkButton.disabled = true;
      try {
        if (provider === 'jellyfin') await api.unlinkJellyfin();
        else await api.unlinkPlex();
        if (!unlinkButton.isConnected) return;
        state.linked = false;
        state.accountDisplayName = '';
        state.serverName = '';
        state.isAdministrator = false;
        showToast(`${label} account unlinked`);
        renderAccount();
        await refreshSettingsNavigation();
        await Promise.resolve(onAccountChanged()).catch(() => {});
      } catch (err) {
        showToast(err.message, true);
        if (unlinkButton.isConnected) unlinkButton.disabled = false;
      }
    });
    accountHost.replaceChildren(accountHeading, status, details, unlinkButton);
  }

  function renderPlexLogin(accountHeading) {
    const status = createLiveStatus('Not linked');
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Linking uses a short code. Media Launcher never asks for your Plex password.';
    const linkButton = document.createElement('button');
    linkButton.type = 'button';
    linkButton.className = 'play-button';
    linkButton.textContent = 'Link with Plex';
    linkButton.addEventListener('click', async () => {
      linkButton.disabled = true;
      status.textContent = 'Requesting a Plex link code…';
      const generation = accountGeneration;
      try {
        if (!accountState.plex.urlEnvironmentManaged) {
          await api.saveSettings({ plexUrl: plexUrlInput.value });
        }
        const pin = await api.requestPlexPin();
        if (
          generation !== accountGeneration ||
          providerSelect.value !== 'plex' ||
          !accountHost.isConnected
        ) return;
        renderPlexPin(pin);
      } catch (err) {
        if (generation !== accountGeneration || !accountHost.isConnected) return;
        status.textContent = err.message;
        showToast(err.message, true);
        linkButton.disabled = false;
      }
    });
    accountHost.replaceChildren(accountHeading, status, hint, linkButton);
  }

  function renderJellyfinLogin(accountHeading) {
    const status = createLiveStatus('Not linked');
    const usernameLabel = document.createElement('label');
    usernameLabel.textContent = 'Jellyfin username';
    const usernameInput = document.createElement('input');
    usernameInput.type = 'text';
    usernameInput.autocomplete = 'username';
    usernameInput.maxLength = 256;
    usernameLabel.appendChild(usernameInput);

    const passwordLabel = document.createElement('label');
    passwordLabel.textContent = 'Jellyfin password';
    const passwordInput = document.createElement('input');
    passwordInput.type = 'password';
    passwordInput.autocomplete = 'current-password';
    passwordInput.maxLength = 4096;
    passwordInput.value = '';
    passwordLabel.appendChild(passwordInput);

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'The password is used once to sign in to Jellyfin. It is never saved by Media Launcher.';
    const loginButton = document.createElement('button');
    loginButton.type = 'button';
    loginButton.className = 'play-button';
    loginButton.textContent = 'Sign in to Jellyfin';
    loginButton.addEventListener('click', async () => {
      const generation = accountGeneration;
      loginButton.disabled = true;
      status.textContent = 'Signing in…';
      try {
        // Revalidate the optional admin PIN without sending the Jellyfin password. This allows an
        // expired in-memory PIN to prompt safely while ensuring a Jellyfin 401 is never mistaken
        // for an admin challenge and resent after a prompt.
        await api.getSettings();
        if (generation !== accountGeneration || !accountHost.isConnected) return;
        const credentials = {
          serverUrl: selectedServerUrl(),
          username: usernameInput.value,
          password: passwordInput.value,
        };
        passwordInput.value = '';
        const pending = await api.loginJellyfin(credentials);
        if (generation !== accountGeneration || !accountHost.isConnected) return;
        const providerWasDisabled = providerSelect.disabled;
        providerSelect.disabled = true;
        let result;
        try {
          result = await api.commitJellyfinLogin(pending.linkId);
        } finally {
          if (providerSelect.isConnected) providerSelect.disabled = providerWasDisabled;
        }
        if (
          generation !== accountGeneration ||
          providerSelect.value !== 'jellyfin' ||
          !accountHost.isConnected
        ) return;
        accountState.jellyfin = {
          ...accountState.jellyfin,
          linked: true,
          accountDisplayName: result.accountDisplayName || usernameInput.value.trim(),
          serverName: result.serverName || '',
          isAdministrator: result.isAdministrator === true,
        };
        activeProvider = 'jellyfin';
        window.dispatchEvent(new Event('media-launcher:provider-linked'));
        Promise.resolve(onAccountChanged()).catch(() => {});
        renderProviderHint();
        showToast('Jellyfin account linked');
        renderAccount();
      } catch (err) {
        if (generation !== accountGeneration || !accountHost.isConnected) return;
        status.textContent = err.message;
        showToast(err.message, true);
        loginButton.disabled = false;
      } finally {
        passwordInput.value = '';
      }
    });
    for (const input of [usernameInput, passwordInput]) {
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        if (!loginButton.disabled) loginButton.click();
      });
    }
    accountHost.replaceChildren(
      accountHeading,
      status,
      usernameLabel,
      passwordLabel,
      hint,
      loginButton
    );
  }

  function renderIncompleteEnvironmentAccount(provider, accountHeading) {
    const label = provider === 'jellyfin' ? 'Jellyfin' : 'Plex';
    const status = createLiveStatus('Environment-managed credentials are incomplete', 'error');
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = provider === 'jellyfin'
      ? 'Set JELLYFIN_URL, JELLYFIN_ACCESS_TOKEN, and JELLYFIN_USER_ID together, then restart the add-on.'
      : 'Complete the Plex environment configuration, then restart the add-on.';
    accountHost.replaceChildren(accountHeading, status, hint);
  }

  function renderAccount() {
    accountGeneration += 1;
    const provider = providerSelect.value;
    const state = accountState[provider];
    const accountHeading = document.createElement('h3');
    accountHeading.textContent = `${provider === 'jellyfin' ? 'Jellyfin' : 'Plex'} account`;
    if (state.linked) renderLinkedAccount(provider, state, accountHeading);
    else if (state.credentialsEnvironmentManaged) {
      renderIncompleteEnvironmentAccount(provider, accountHeading);
    }
    else if (provider === 'jellyfin') renderJellyfinLogin(accountHeading);
    else renderPlexLogin(accountHeading);
  }

  function updateProviderFields() {
    const useJellyfin = providerSelect.value === 'jellyfin';
    plexUrlLabel.hidden = useJellyfin;
    jellyfinUrlLabel.hidden = !useJellyfin;
    plexUrlInput.disabled = useJellyfin || accountState.plex.urlEnvironmentManaged;
    jellyfinUrlInput.disabled = !useJellyfin || accountState.jellyfin.urlEnvironmentManaged;
    plexUrlInput.title = accountState.plex.urlEnvironmentManaged
      ? 'Plex server URL is managed by PLEX_URL'
      : '';
    jellyfinUrlInput.title = accountState.jellyfin.urlEnvironmentManaged
      ? 'Jellyfin server URL is managed by JELLYFIN_URL'
      : '';
    renderProviderHint();
    renderAccount();
  }

  providerSelect.addEventListener('change', updateProviderFields);
  section.append(
    heading,
    providerLabel,
    plexUrlLabel,
    jellyfinUrlLabel,
    providerHint,
    accountHost
  );
  updateProviderFields();
  return { section, providerSelect, plexUrlInput, jellyfinUrlInput };
}

function renderPathMapRow(rule, platform = 'windows') {
  const row = document.createElement('div');
  row.className = 'pathmap-row';

  const label = document.createElement('div');
  label.className = 'pathmap-label';
  label.textContent = rule.library || '';

  const fromInput = document.createElement('input');
  fromInput.type = 'text';
  fromInput.placeholder = '/volume1/video/Movies (server path)';
  fromInput.value = rule.from || '';
  fromInput.dataset.field = 'from';
  fromInput.setAttribute('aria-label', rule.library
    ? `${rule.library} path reported by the media server`
    : 'Path reported by the media server');

  const toInput = document.createElement('input');
  toInput.type = 'text';
  toInput.placeholder = platform === 'linux'
    ? '/mnt/media/Movies (path on this device)'
    : '//nas-host/share/Movies (path on this device)';
  toInput.value = rule.to || '';
  toInput.dataset.field = 'to';
  toInput.setAttribute('aria-label', rule.library
    ? `${rule.library} path on this playback device`
    : 'Path on this playback device');

  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'icon-button';
  removeButton.title = 'Remove mapping';
  removeButton.setAttribute('aria-label', 'Remove mapping');
  removeButton.textContent = '✕';
  removeButton.addEventListener('click', () => row.remove());
  row.append(label, fromInput, toInput, removeButton);
  return row;
}

function collectPathMap(container) {
  const rules = Array.from(container.querySelectorAll('.pathmap-row'))
    .map((row) => {
      const rule = {
        from: row.querySelector('[data-field="from"]').value.trim(),
        to: row.querySelector('[data-field="to"]').value.trim(),
      };
      const library = row.querySelector('.pathmap-label').textContent.trim();
      if (library) rule.library = library;
      return rule;
    });
  if (rules.some((rule) => Boolean(rule.from) !== Boolean(rule.to))) {
    throw new Error('Each library path mapping needs both a server path and a device path.');
  }
  return rules.filter((rule) => rule.from && rule.to);
}

function removeEmptyPlaceholderRow(container) {
  const rows = container.querySelectorAll('.pathmap-row');
  if (rows.length !== 1) return;
  const only = rows[0];
  if (
    !only.querySelector('[data-field="from"]').value.trim() &&
    !only.querySelector('[data-field="to"]').value.trim()
  ) only.remove();
}

function createPathMapGroup(agent, fallbackRules) {
  const group = document.createElement('div');
  group.className = 'agent-pathmap-group';
  const platform = agent?.platform || 'windows';
  group.dataset.platform = platform;

  if (agent) {
    const title = document.createElement('h3');
    title.textContent = `${agent.name} · ${platform}`;
    group.appendChild(title);
  }

  const rows = document.createElement('div');
  rows.className = 'pathmap-rows';
  const configured = agent && Array.isArray(agent.pathMap) ? agent.pathMap : fallbackRules;
  const rules = configured?.length ? configured : [{ from: '', to: '' }];
  for (const rule of rules) rows.appendChild(renderPathMapRow(rule, platform));

  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.className = 'icon-button-wide';
  addButton.textContent = '+ Add mapping';
  addButton.addEventListener('click', () =>
    rows.appendChild(renderPathMapRow({ from: '', to: '' }, platform))
  );
  group.append(rows, addButton);
  return group;
}

function playerCanLaunch(player) {
  return player?.available !== false &&
    Array.isArray(player?.capabilities) &&
    player.capabilities.includes('play.file');
}

function createAgentCard(agent, nameInputs, statusByAgentId) {
  const card = document.createElement('div');
  card.className = 'agent-card';

  const heading = document.createElement('div');
  heading.className = 'agent-card-heading';
  const title = document.createElement('strong');
  title.textContent = agent.name;
  const status = document.createElement('span');
  status.className = 'agent-online-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent = agent.paired ? 'Checking…' : 'Pairing pending';
  statusByAgentId.set(agent.id, status);
  heading.append(title, status);

  const meta = document.createElement('div');
  meta.className = 'agent-meta';
  meta.textContent = [agent.platform, agent.architecture, agent.version].filter(Boolean).join(' · ');

  const nameLabel = document.createElement('label');
  nameLabel.textContent = 'Friendly name';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = agent.name;
  nameInput.maxLength = 80;
  nameInputs.set(agent.id, nameInput);
  nameInput.addEventListener('input', () => {
    title.textContent = nameInput.value.trim() || agent.name;
  });
  nameLabel.appendChild(nameInput);

  const players = document.createElement('div');
  players.className = 'agent-player-list';
  for (const player of Array.isArray(agent.players) ? agent.players : []) {
    const badge = document.createElement('span');
    badge.className = 'player-badge';
    const monitored = ['status.state', 'status.position', 'status.duration']
      .every((capability) => player.capabilities?.includes(capability));
    badge.textContent = player.available === false
      ? `${player.name} · unavailable`
      : monitored ? player.name : `${player.name} · launch only`;
    badge.classList.toggle('unavailable', player.available === false);
    players.appendChild(badge);
  }

  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'icon-button-wide danger-button';
  removeButton.textContent = 'Remove device';
  removeButton.addEventListener('click', async () => {
    if (!window.confirm(
      `Remove ${agent.name}? It must reset pairing locally before it can return. ` +
      'Any other unsaved changes on this page will be discarded.'
    )) return;
    removeButton.disabled = true;
    try {
      await api.removePlayerAgent(agent.id);
      showToast(`${agent.name} removed`);
      if (removeButton.isConnected) await renderSettingsView();
    } catch (err) {
      showToast(err.message, true);
      if (removeButton.isConnected) removeButton.disabled = false;
    }
  });
  card.append(heading, meta, nameLabel, players, removeButton);
  return card;
}

function showSettingsMessage(message, isError = false) {
  const paragraph = document.createElement('p');
  paragraph.textContent = message;
  if (isError) {
    paragraph.className = 'error';
    paragraph.setAttribute('role', 'alert');
  }
  appEl.replaceChildren(paragraph);
}

async function renderSettingsView() {
  setActiveNav('settings');
  clearAmbientBackground();
  showSettingsMessage('Loading settings…');

  let settings;
  try {
    settings = await api.getSettings();
  } catch (err) {
    showSettingsMessage(err.message, true);
    return;
  }

  const agents = Array.isArray(settings.agents) ? settings.agents : [];
  const pairedAgents = agents.filter((agent) => agent.paired);
  const pendingAgents = agents.filter((agent) => !agent.paired);
  const usableAgents = pairedAgents.filter((agent) =>
    (Array.isArray(agent.players) ? agent.players : []).some(playerCanLaunch)
  );

  const wrap = document.createElement('div');
  wrap.className = 'settings-view';
  const pageHeading = document.createElement('h1');
  pageHeading.textContent = 'Settings';
  pageHeading.tabIndex = -1;
  const form = document.createElement('form');
  form.className = 'settings-form';

  const mediaControls = createMediaServerSection(settings, () => refreshDiscoveryButton());

  const pathMapSection = document.createElement('section');
  pathMapSection.className = 'settings-section';
  const pathMapHeading = document.createElement('h2');
  pathMapHeading.textContent = 'Library path mapping';
  const pathMapHint = document.createElement('p');
  pathMapHint.className = 'hint';
  pathMapHint.textContent = pairedAgents.length
    ? 'Map each media library folder to the path visible from each paired playback device.'
    : 'Pair a player agent to keep separate path mappings for each playback device.';
  const discoverButton = document.createElement('button');
  discoverButton.type = 'button';
  discoverButton.className = 'icon-button-wide';
  discoverButton.textContent = 'Discover from media server';
  function applyDiscoveryAvailability(mediaServer) {
    const unavailable = !mediaServer?.ready || mediaServer?.capabilities?.scanLibrary !== true;
    discoverButton.disabled = unavailable;
    discoverButton.title = unavailable
      ? mediaServer?.provider === 'jellyfin' && mediaServer?.authenticated
        ? 'Jellyfin path discovery requires an administrator account'
        : 'Link the active media server before discovering library paths'
      : '';
  }
  async function refreshDiscoveryButton() {
    const bootstrap = await api.getBootstrap();
    if (discoverButton.isConnected) applyDiscoveryAvailability(bootstrap?.mediaServer);
  }
  applyDiscoveryAvailability(settings.mediaServer);

  const pathMapGroups = document.createElement('div');
  pathMapGroups.className = 'agent-pathmap-groups';
  const pathGroupsByAgentId = new Map();
  if (agents.length) {
    for (const agent of agents) {
      const group = createPathMapGroup(agent, settings.pathMap || []);
      pathGroupsByAgentId.set(agent.id, group);
      pathMapGroups.appendChild(group);
    }
  } else {
    pathMapGroups.appendChild(createPathMapGroup(null, settings.pathMap || []));
  }

  discoverButton.addEventListener('click', async () => {
    discoverButton.disabled = true;
    try {
      const result = await api.getMediaServerLibraryPaths();
      if (!discoverButton.isConnected) return;
      const paths = Array.isArray(result.paths) ? result.paths : [];
      let added = 0;
      for (const group of pathMapGroups.children) {
        const rows = group.querySelector('.pathmap-rows');
        removeEmptyPlaceholderRow(rows);
        const existing = new Set(
          Array.from(rows.querySelectorAll('[data-field="from"]'))
            .map((input) => input.value.trim())
        );
        for (const entry of paths) {
          const libraryPath = typeof entry?.path === 'string' ? entry.path : '';
          const library = typeof entry?.library === 'string' ? entry.library : '';
          if (!libraryPath || existing.has(libraryPath)) continue;
          rows.appendChild(renderPathMapRow(
            { from: libraryPath, to: '', library },
            group.dataset.platform || 'windows'
          ));
          existing.add(libraryPath);
          added += 1;
        }
      }
      showToast(added
        ? `Added ${added} device mapping row${added === 1 ? '' : 's'}`
        : 'No new library folders found');
    } catch (err) {
      showToast(err.message, true);
    } finally {
      if (discoverButton.isConnected) discoverButton.disabled = false;
    }
  });
  pathMapSection.append(pathMapHeading, pathMapHint, discoverButton, pathMapGroups);

  const connectionsSection = document.createElement('section');
  connectionsSection.className = 'settings-section';
  const connectionsHeading = document.createElement('h2');
  connectionsHeading.textContent = 'Connections';
  const agentHeading = document.createElement('h3');
  agentHeading.textContent = 'Paired playback devices';
  const agentList = document.createElement('div');
  agentList.className = 'agent-list';
  const agentNameInputs = new Map();
  const agentStatuses = new Map();
  if (agents.length) {
    for (const agent of agents) {
      agentList.appendChild(createAgentCard(agent, agentNameInputs, agentStatuses));
    }
  } else {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'No agents paired. Enter this add-on URL in a player agent and it will appear here automatically.';
    agentList.appendChild(empty);
  }
  if (pairedAgents.length && !usableAgents.length) {
    const noPlayers = document.createElement('p');
    noPlayers.className = 'hint error';
    noPlayers.textContent = 'No paired device currently advertises an available media player.';
    agentList.appendChild(noPlayers);
  }

  const targetLabel = document.createElement('label');
  targetLabel.textContent = 'Default playback target';
  const targetSelect = document.createElement('select');
  const noDefault = document.createElement('option');
  noDefault.value = '';
  noDefault.textContent = 'No default';
  targetSelect.appendChild(noDefault);
  for (const agent of agents) {
    if (!agent.paired) continue;
    for (const player of (Array.isArray(agent.players) ? agent.players : []).filter(playerCanLaunch)) {
      const option = document.createElement('option');
      option.value = player.id;
      option.textContent = `${agent.name} — ${player.name}`;
      option.selected = player.id === settings.defaultPlaybackTargetId;
      targetSelect.appendChild(option);
    }
  }
  if (
    settings.defaultPlaybackTargetId &&
    !Array.from(targetSelect.options)
      .some((option) => option.value === settings.defaultPlaybackTargetId)
  ) {
    const unavailableDefault = document.createElement('option');
    unavailableDefault.value = settings.defaultPlaybackTargetId;
    unavailableDefault.textContent = 'Configured target unavailable';
    unavailableDefault.disabled = true;
    unavailableDefault.selected = true;
    targetSelect.appendChild(unavailableDefault);
  }
  targetLabel.appendChild(targetSelect);

  const alwaysAskLabel = document.createElement('label');
  alwaysAskLabel.className = 'checkbox-label';
  const alwaysAskInput = document.createElement('input');
  alwaysAskInput.type = 'checkbox';
  alwaysAskInput.checked = settings.alwaysAskPlaybackTarget !== false;
  const alwaysAskText = document.createElement('span');
  alwaysAskText.textContent = 'Always ask where to play when more than one target is online';
  alwaysAskLabel.append(alwaysAskInput, alwaysAskText);

  connectionsSection.append(
    connectionsHeading,
    agentHeading,
    agentList,
    targetLabel,
    alwaysAskLabel
  );

  const securitySection = document.createElement('section');
  securitySection.className = 'settings-section';
  const securityHeading = document.createElement('h2');
  securityHeading.textContent = 'Security';
  const adminPinLabel = document.createElement('label');
  adminPinLabel.textContent = settings.adminPinConfigured
    ? 'Change admin PIN (optional)'
    : 'Admin PIN (optional)';
  const adminPinInput = document.createElement('input');
  adminPinInput.type = 'password';
  adminPinInput.inputMode = 'numeric';
  adminPinInput.autocomplete = 'new-password';
  adminPinInput.minLength = 4;
  adminPinInput.maxLength = 12;
  adminPinInput.pattern = '[0-9]{4,12}';
  adminPinInput.placeholder = settings.adminPinConfigured
    ? 'Leave blank to keep the current PIN'
    : 'Optional, 4 to 12 digits';
  adminPinLabel.appendChild(adminPinInput);

  const disablePinButton = document.createElement('button');
  disablePinButton.type = 'button';
  disablePinButton.className = 'icon-button-wide';
  disablePinButton.textContent = 'Disable admin PIN';
  disablePinButton.hidden = !settings.adminPinConfigured;
  disablePinButton.addEventListener('click', async () => {
    if (!window.confirm('Disable the admin PIN? Settings and account linking will no longer require it.')) {
      return;
    }
    disablePinButton.disabled = true;
    try {
      await api.disableAdminPin();
      if (!disablePinButton.isConnected) return;
      settings.adminPinConfigured = false;
      adminPinInput.value = '';
      adminPinInput.placeholder = 'Optional, 4 to 12 digits';
      adminPinLabel.firstChild.textContent = 'Admin PIN (optional)';
      disablePinButton.hidden = true;
      showToast('Admin PIN disabled');
    } catch (err) {
      showToast(err.message, true);
    } finally {
      if (disablePinButton.isConnected) disablePinButton.disabled = false;
    }
  });

  const pairingStatus = document.createElement('p');
  pairingStatus.className = `pairing-status${pairedAgents.length ? ' paired' : ''}`;
  pairingStatus.setAttribute('role', 'status');
  pairingStatus.setAttribute('aria-live', 'polite');
  pairingStatus.textContent = pairedAgents.length
    ? `✓ ${pairedAgents.length} paired device${pairedAgents.length === 1 ? '' : 's'}, each with its own key`
    : agents.length
      ? 'Pairing pending — the player agent will retry automatically'
      : 'No paired player agents';
  const securityHint = document.createElement('p');
  securityHint.className = 'hint';
  securityHint.textContent =
    'The PIN only protects settings and account linking. Agent pairing exchanges separate keys automatically and does not depend on the PIN.';
  securitySection.append(
    securityHeading,
    adminPinLabel,
    disablePinButton,
    pairingStatus,
    securityHint
  );

  const saveButton = document.createElement('button');
  saveButton.type = 'submit';
  saveButton.className = 'play-button settings-save';
  saveButton.textContent = 'Save';

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    saveButton.disabled = true;
    try {
      const agentSettings = agents.map((agent) => ({
        id: agent.id,
        name: agentNameInputs.get(agent.id).value.trim(),
        pathMap: collectPathMap(pathGroupsByAgentId.get(agent.id)),
      }));
      const legacyGroup = agents.length ? null : pathMapGroups.firstElementChild;
      await api.saveSettings({
        mediaProvider: mediaControls.providerSelect.value,
        ...(mediaControls.providerSelect.value === 'jellyfin'
          ? mediaControls.jellyfinUrlInput.disabled
            ? {}
            : { jellyfinUrl: mediaControls.jellyfinUrlInput.value }
          : mediaControls.plexUrlInput.disabled
            ? {}
            : { plexUrl: mediaControls.plexUrlInput.value }),
        pathMap: legacyGroup ? collectPathMap(legacyGroup) : settings.pathMap || [],
        agentSettings,
        defaultPlaybackTargetId: targetSelect.value,
        alwaysAskPlaybackTarget: alwaysAskInput.checked,
        ...(adminPinInput.value ? { newAdminPin: adminPinInput.value } : {}),
      });
      showToast('Settings saved');
      await refreshSettingsNavigation();
      if (saveButton.isConnected) await renderSettingsView();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      if (saveButton.isConnected) saveButton.disabled = false;
    }
  });

  form.append(
    mediaControls.section,
    pathMapSection,
    connectionsSection,
    securitySection,
    saveButton
  );
  wrap.append(pageHeading, form);
  appEl.replaceChildren(wrap);

  api.getPlaybackTargets().then(({ agents: states = [] }) => {
    if (!wrap.isConnected) return;
    const stateById = new Map(states.map((state) => [state.id, state]));
    for (const [agentId, status] of agentStatuses) {
      const state = stateById.get(agentId);
      const online = state?.online || false;
      status.textContent = !state?.paired
        ? 'Pairing pending'
        : online ? '● Online' : '● Offline';
      status.classList.toggle('online', online);
    }
  }).catch(() => {});
}
