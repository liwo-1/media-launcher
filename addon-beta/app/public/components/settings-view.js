function renderPlexAuthSection(linked) {
  const section = document.createElement('div');
  section.className = 'settings-section';

  function renderLinked() {
    section.innerHTML = '';
    const heading = document.createElement('h2');
    heading.textContent = 'Plex Account';
    const status = document.createElement('p');
    status.className = 'link-status';
    status.textContent = '✓ Linked';
    const unlinkBtn = document.createElement('button');
    unlinkBtn.type = 'button';
    unlinkBtn.className = 'icon-button-wide';
    unlinkBtn.textContent = 'Unlink';
    unlinkBtn.addEventListener('click', async () => {
      unlinkBtn.disabled = true;
      try {
        await api.unlinkPlex();
        renderUnlinked();
      } catch (err) {
        showToast(err.message, true);
        unlinkBtn.disabled = false;
      }
    });
    section.append(heading, status, unlinkBtn);
  }

  function renderUnlinked() {
    section.innerHTML = '';
    const heading = document.createElement('h2');
    heading.textContent = 'Plex Account';
    const status = document.createElement('p');
    status.className = 'link-status';
    status.textContent = 'Not linked';
    const linkBtn = document.createElement('button');
    linkBtn.type = 'button';
    linkBtn.className = 'play-button';
    linkBtn.textContent = 'Link with Plex';
    linkBtn.addEventListener('click', async () => {
      linkBtn.disabled = true;
      try {
        const pin = await api.requestPlexPin();
        renderPin(pin);
      } catch (err) {
        showToast(err.message, true);
        linkBtn.disabled = false;
      }
    });
    section.append(heading, status, linkBtn);
  }

  function renderPin(pin) {
    section.innerHTML = '';
    const heading = document.createElement('h2');
    heading.textContent = 'Plex Account';
    const instructions = document.createElement('p');
    instructions.innerHTML = `Go to <a href="${pin.linkUrl}" target="_blank" rel="noopener">plex.tv/link</a> and enter this code:`;
    const code = document.createElement('div');
    code.className = 'link-code';
    code.textContent = pin.code;
    const status = document.createElement('p');
    status.className = 'link-status';
    status.textContent = 'Waiting for confirmation…';
    section.append(heading, instructions, code, status);

    async function poll() {
      if (!section.isConnected) return;
      try {
        const result = await api.checkPlexPin(pin.id);
        if (result.linked) {
          renderLinked();
          return;
        }
      } catch (err) {
        status.textContent = err.message;
      }
      setTimeout(poll, 2000);
    }
    poll();
  }

  if (linked) renderLinked();
  else renderUnlinked();
  return section;
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

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'icon-button';
  removeBtn.title = 'Remove mapping';
  removeBtn.textContent = '✕';
  removeBtn.addEventListener('click', () => row.remove());
  row.append(label, fromInput, toInput, removeBtn);
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
  group.dataset.agentId = agent?.id || '';
  group.dataset.platform = agent?.platform || 'windows';

  if (agent) {
    const title = document.createElement('h3');
    title.textContent = `${agent.name} · ${agent.platform}`;
    group.appendChild(title);
  }

  const rows = document.createElement('div');
  rows.className = 'pathmap-rows';
  const configured = agent && Array.isArray(agent.pathMap) ? agent.pathMap : fallbackRules;
  const rules = configured?.length ? configured : [{ from: '', to: '' }];
  for (const rule of rules) rows.appendChild(renderPathMapRow(rule, group.dataset.platform));

  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.className = 'icon-button-wide';
  addButton.textContent = '+ Add mapping';
  addButton.addEventListener('click', () =>
    rows.appendChild(renderPathMapRow({ from: '', to: '' }, group.dataset.platform))
  );
  group.append(rows, addButton);
  return group;
}

function createAgentCard(agent) {
  const card = document.createElement('div');
  card.className = 'agent-card';
  card.dataset.agentId = agent.id;

  const heading = document.createElement('div');
  heading.className = 'agent-card-heading';
  const title = document.createElement('strong');
  title.textContent = agent.name;
  const status = document.createElement('span');
  status.className = 'agent-online-status';
  status.textContent = agent.paired ? 'Checking…' : 'Pairing pending';
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
  nameInput.dataset.agentName = agent.id;
  nameInput.addEventListener('input', () => {
    title.textContent = nameInput.value.trim() || agent.name;
  });
  nameLabel.appendChild(nameInput);

  const players = document.createElement('div');
  players.className = 'agent-player-list';
  for (const player of agent.players) {
    const badge = document.createElement('span');
    badge.className = 'player-badge';
    const monitored = ['status.state', 'status.position', 'status.duration']
      .every((capability) => player.capabilities.includes(capability));
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
      await renderSettingsView();
    } catch (err) {
      showToast(err.message, true);
      removeButton.disabled = false;
    }
  });
  card.append(heading, meta, nameLabel, players, removeButton);
  return card;
}

async function renderSettingsView() {
  setActiveNav('settings');
  clearAmbientBackground();
  appEl.innerHTML = '<p>Loading settings...</p>';

  let settings;
  try {
    settings = await api.getSettings();
  } catch (err) {
    appEl.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
    return;
  }

  const agents = settings.agents || [];
  const pairedAgents = agents.filter((agent) => agent.paired);
  const pendingAgents = agents.filter((agent) => !agent.paired);
  const usableAgents = pairedAgents.filter((agent) =>
    agent.players.some((player) =>
      player.available !== false && player.capabilities.includes('play.file')
    )
  );
  appEl.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'settings-view';
  const form = document.createElement('form');
  form.className = 'settings-form';

  const pathMapSection = document.createElement('div');
  pathMapSection.className = 'settings-section';
  const pathMapHeading = document.createElement('h2');
  pathMapHeading.textContent = 'Library path mapping';
  const pathMapHint = document.createElement('p');
  pathMapHint.className = 'hint';
  pathMapHint.textContent = pairedAgents.length
    ? 'Map each Plex library folder to the path visible from each paired device.'
    : 'Pair a player agent to keep separate path mappings for each playback device.';
  const discoverBtn = document.createElement('button');
  discoverBtn.type = 'button';
  discoverBtn.className = 'icon-button-wide';
  discoverBtn.textContent = 'Discover from Plex';

  const pathMapGroups = document.createElement('div');
  pathMapGroups.className = 'agent-pathmap-groups';
  if (agents.length) {
    for (const agent of agents) pathMapGroups.appendChild(createPathMapGroup(agent, settings.pathMap || []));
  } else {
    pathMapGroups.appendChild(createPathMapGroup(null, settings.pathMap || []));
  }

  discoverBtn.addEventListener('click', async () => {
    discoverBtn.disabled = true;
    try {
      const { paths } = await api.getPlexLibraryPaths();
      let added = 0;
      for (const group of pathMapGroups.querySelectorAll('.agent-pathmap-group')) {
        const rows = group.querySelector('.pathmap-rows');
        removeEmptyPlaceholderRow(rows);
        const existing = new Set(
          Array.from(rows.querySelectorAll('[data-field="from"]')).map((input) => input.value.trim())
        );
        for (const { path: libraryPath, library } of paths) {
          if (existing.has(libraryPath)) continue;
          rows.appendChild(renderPathMapRow(
            { from: libraryPath, to: '', library },
            group.dataset.platform
          ));
          added++;
        }
      }
      showToast(added ? `Added ${added} device mapping row${added === 1 ? '' : 's'}` : 'No new library folders found');
    } catch (err) {
      showToast(err.message, true);
    } finally {
      discoverBtn.disabled = false;
    }
  });
  pathMapSection.append(pathMapHeading, pathMapHint, discoverBtn, pathMapGroups);

  const connSection = document.createElement('div');
  connSection.className = 'settings-section';
  const connHeading = document.createElement('h2');
  connHeading.textContent = 'Connections';

  const plexUrlLabel = document.createElement('label');
  plexUrlLabel.textContent = 'Plex server URL';
  const plexUrlInput = document.createElement('input');
  plexUrlInput.type = 'text';
  plexUrlInput.placeholder = 'http://192.168.1.x:32400';
  plexUrlInput.value = settings.plexUrl || '';
  plexUrlLabel.appendChild(plexUrlInput);

  const agentHeading = document.createElement('h3');
  agentHeading.textContent = 'Paired playback devices';
  const agentList = document.createElement('div');
  agentList.className = 'agent-list';
  if (agents.length) {
    for (const agent of agents) agentList.appendChild(createAgentCard(agent));
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
    for (const player of agent.players.filter((candidate) =>
      candidate.available !== false && candidate.capabilities.includes('play.file')
    )) {
      const option = document.createElement('option');
      option.value = player.id;
      option.textContent = `${agent.name} — ${player.name}`;
      option.selected = player.id === settings.defaultPlaybackTargetId;
      targetSelect.appendChild(option);
    }
  }
  if (
    settings.defaultPlaybackTargetId &&
    !Array.from(targetSelect.options).some((option) => option.value === settings.defaultPlaybackTargetId)
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

  const playerUrlLabel = document.createElement('label');
  playerUrlLabel.textContent = 'Player agent URL';
  const playerUrlInput = document.createElement('input');
  playerUrlInput.type = 'text';
  playerUrlInput.placeholder = 'http://192.168.1.x:7777';
  playerUrlInput.value = settings.playerAgentUrl || '';
  playerUrlLabel.appendChild(playerUrlInput);

  connSection.append(
    connHeading,
    plexUrlLabel,
    agentHeading,
    agentList,
    targetLabel,
    alwaysAskLabel
  );
  const manualPairingNeeded = pendingAgents.length > 0 || pairedAgents.length === 0;
  if (manualPairingNeeded) connSection.appendChild(playerUrlLabel);

  const securitySection = document.createElement('div');
  securitySection.className = 'settings-section';
  const securityHeading = document.createElement('h2');
  securityHeading.textContent = 'Security';
  const adminPinLabel = document.createElement('label');
  adminPinLabel.textContent = settings.adminPinConfigured ? 'Change admin PIN (optional)' : 'Admin PIN (optional)';
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

  const disablePinBtn = document.createElement('button');
  disablePinBtn.type = 'button';
  disablePinBtn.className = 'icon-button-wide';
  disablePinBtn.textContent = 'Disable admin PIN';
  disablePinBtn.hidden = !settings.adminPinConfigured;
  disablePinBtn.addEventListener('click', async () => {
    disablePinBtn.disabled = true;
    try {
      await api.disableAdminPin();
      settings.adminPinConfigured = false;
      adminPinInput.value = '';
      adminPinInput.placeholder = 'Optional, 4 to 12 digits';
      adminPinLabel.firstChild.textContent = 'Admin PIN (optional)';
      disablePinBtn.hidden = true;
      showToast('Admin PIN disabled');
    } catch (err) {
      showToast(err.message, true);
    } finally {
      disablePinBtn.disabled = false;
    }
  });

  const pairingStatus = document.createElement('p');
  pairingStatus.className = `pairing-status${pairedAgents.length ? ' paired' : ''}`;
  pairingStatus.textContent = pairedAgents.length
    ? `✓ ${pairedAgents.length} paired device${pairedAgents.length === 1 ? '' : 's'}, each with its own key`
    : agents.length ? 'Pairing pending — save to retry' : 'No paired player agents';
  const securityHint = document.createElement('p');
  securityHint.className = 'hint';
  securityHint.textContent =
    'The PIN only protects settings and account linking. Agent pairing exchanges separate keys automatically and does not depend on the PIN.';
  securitySection.append(securityHeading, adminPinLabel, disablePinBtn, pairingStatus, securityHint);

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'play-button settings-save';
  saveBtn.textContent = 'Save';

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    saveBtn.disabled = true;
    try {
      const agentSettings = agents.map((agent) => {
        const nameInput = form.querySelector(`[data-agent-name="${agent.id}"]`);
        const group = pathMapGroups.querySelector(`[data-agent-id="${agent.id}"]`);
        return {
          id: agent.id,
          name: nameInput.value.trim(),
          pathMap: collectPathMap(group),
        };
      });
      const legacyGroup = pathMapGroups.querySelector('[data-agent-id=""]');
      await api.saveSettings({
        plexUrl: plexUrlInput.value,
        ...(manualPairingNeeded ? { playerAgentUrl: playerUrlInput.value } : {}),
        pathMap: legacyGroup ? collectPathMap(legacyGroup) : settings.pathMap || [],
        agentSettings,
        defaultPlaybackTargetId: targetSelect.value,
        alwaysAskPlaybackTarget: alwaysAskInput.checked,
        ...(adminPinInput.value ? { newAdminPin: adminPinInput.value } : {}),
      });
      if (manualPairingNeeded && playerUrlInput.value.trim()) {
        try {
          await api.pairPlayerAgent();
        } catch (err) {
          throw new Error(`Settings saved, but pairing failed: ${err.message}`);
        }
        showToast('Settings saved and player agent paired');
        await renderSettingsView();
        return;
      }
      showToast('Settings saved');
      if (adminPinInput.value) {
        settings.adminPinConfigured = true;
        adminPinInput.value = '';
        adminPinInput.placeholder = 'Leave blank to keep the current PIN';
        adminPinLabel.firstChild.textContent = 'Change admin PIN (optional)';
        disablePinBtn.hidden = false;
      }
      await buildNav().catch(() => {});
    } catch (err) {
      showToast(err.message, true);
    } finally {
      saveBtn.disabled = false;
    }
  });

  form.append(pathMapSection, connSection, securitySection, saveBtn);
  wrap.append(renderPlexAuthSection(settings.plexLinked), form);
  appEl.appendChild(wrap);

  api.getPlaybackTargets().then(({ agents: states = [] }) => {
    const stateById = new Map(states.map((state) => [state.id, state]));
    for (const card of agentList.querySelectorAll('.agent-card')) {
      const status = card.querySelector('.agent-online-status');
      const state = stateById.get(card.dataset.agentId);
      const online = state?.online || false;
      status.textContent = !state?.paired ? 'Pairing pending' : online ? '● Online' : '● Offline';
      status.classList.toggle('online', online);
    }
  }).catch(() => {});
}
