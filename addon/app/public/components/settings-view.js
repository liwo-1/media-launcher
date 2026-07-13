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

function renderPathMapRow(rule) {
  const row = document.createElement('div');
  row.className = 'pathmap-row';

  const label = document.createElement('div');
  label.className = 'pathmap-label';
  label.textContent = rule.library || '';

  const fromInput = document.createElement('input');
  fromInput.type = 'text';
  fromInput.placeholder = '/volume1/video/Movies (Plex library path)';
  fromInput.value = rule.from || '';
  fromInput.dataset.field = 'from';

  const toInput = document.createElement('input');
  toInput.type = 'text';
  toInput.placeholder = '//nas-host/share/Movies (UNC path, forward slashes)';
  toInput.value = rule.to || '';
  toInput.dataset.field = 'to';

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
  return Array.from(container.querySelectorAll('.pathmap-row'))
    .map((row) => {
      const rule = {
        from: row.querySelector('[data-field="from"]').value.trim(),
        to: row.querySelector('[data-field="to"]').value.trim(),
      };
      const library = row.querySelector('.pathmap-label').textContent.trim();
      if (library) rule.library = library;
      return rule;
    })
    .filter((rule) => rule.from && rule.to);
}

function removeEmptyPlaceholderRow(container) {
  const rows = container.querySelectorAll('.pathmap-row');
  if (rows.length !== 1) return;
  const only = rows[0];
  const from = only.querySelector('[data-field="from"]').value.trim();
  const to = only.querySelector('[data-field="to"]').value.trim();
  if (!from && !to) only.remove();
}

async function renderSettingsView() {
  setActiveNav('settings');
  clearAmbientBackground();
  appEl.innerHTML = '<p>Loading settings...</p>';

  let settings;
  try {
    settings = await api.getSettings();
  } catch (err) {
    appEl.innerHTML = `<p class="error">${err.message}</p>`;
    return;
  }

  appEl.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'settings-view';

  const form = document.createElement('form');
  form.className = 'settings-form';

  const securitySection = document.createElement('div');
  securitySection.className = 'settings-section';
  const securityHeading = document.createElement('h2');
  securityHeading.textContent = 'Security';

  const adminPinLabel = document.createElement('label');
  adminPinLabel.textContent = settings.adminPinConfigured ? 'Change admin PIN (optional)' : 'Set admin PIN';
  const adminPinInput = document.createElement('input');
  adminPinInput.type = 'password';
  adminPinInput.inputMode = 'numeric';
  adminPinInput.autocomplete = 'new-password';
  adminPinInput.minLength = 4;
  adminPinInput.maxLength = 12;
  adminPinInput.pattern = '[0-9]{4,12}';
  adminPinInput.placeholder = settings.adminPinConfigured ? 'Leave blank to keep the current PIN' : '4 to 12 digits';
  adminPinInput.required = !settings.adminPinConfigured;
  adminPinLabel.appendChild(adminPinInput);

  const pairingLabel = document.createElement('label');
  pairingLabel.textContent = 'Player agent pairing';
  const pairingStatus = document.createElement('div');
  pairingStatus.className = 'pairing-status';
  pairingStatus.textContent = settings.playerAgentUrl ? 'Checking…' : 'Not configured';
  pairingLabel.appendChild(pairingStatus);

  const securityHint = document.createElement('p');
  securityHint.className = 'hint';
  securityHint.textContent =
    'The admin PIN protects settings and Plex linking. The player agent pairs automatically once and rejects remote re-pairing.';
  securitySection.append(securityHeading, adminPinLabel, pairingLabel, securityHint);

  const connSection = document.createElement('div');
  connSection.className = 'settings-section';
  const connHeading = document.createElement('h2');
  connHeading.textContent = 'Connections';

  const plexUrlLabel = document.createElement('label');
  plexUrlLabel.textContent = 'Plex server URL';
  const plexUrlInput = document.createElement('input');
  plexUrlInput.type = 'text';
  plexUrlInput.name = 'plexUrl';
  plexUrlInput.placeholder = 'http://192.168.1.x:32400';
  plexUrlInput.value = settings.plexUrl || '';
  plexUrlLabel.appendChild(plexUrlInput);

  const playerUrlLabel = document.createElement('label');
  playerUrlLabel.textContent = 'Player agent URL (media PC)';
  const playerUrlInput = document.createElement('input');
  playerUrlInput.type = 'text';
  playerUrlInput.name = 'playerAgentUrl';
  playerUrlInput.placeholder = 'http://192.168.1.x:7777';
  playerUrlInput.value = settings.playerAgentUrl || '';
  playerUrlLabel.appendChild(playerUrlInput);

  async function refreshPlayerAgentPairing() {
    if (!playerUrlInput.value.trim()) {
      pairingStatus.className = 'pairing-status';
      pairingStatus.textContent = 'Not configured';
      return;
    }

    pairingStatus.className = 'pairing-status';
    pairingStatus.textContent = 'Checking…';
    try {
      const result = await api.pairPlayerAgent();
      pairingStatus.className = 'pairing-status paired';
      pairingStatus.textContent = result.alreadyPaired ? '✓ Paired' : '✓ Paired automatically';
    } catch (err) {
      pairingStatus.className = 'pairing-status error';
      pairingStatus.textContent = `✕ ${err.message}`;
    }
  }

  connSection.append(connHeading, plexUrlLabel, playerUrlLabel);

  const pathMapSection = document.createElement('div');
  pathMapSection.className = 'settings-section';
  const pathMapHeading = document.createElement('h2');
  pathMapHeading.textContent = 'Library path mapping';
  const pathMapHint = document.createElement('p');
  pathMapHint.className = 'hint';
  pathMapHint.textContent =
    'Map each Plex library folder path to its Windows UNC path on the media PC. Use forward slashes on both sides.';
  const pathMapRows = document.createElement('div');
  pathMapRows.className = 'pathmap-rows';
  const rules = settings.pathMap && settings.pathMap.length ? settings.pathMap : [{ from: '', to: '' }];
  for (const rule of rules) pathMapRows.appendChild(renderPathMapRow(rule));

  const discoverBtn = document.createElement('button');
  discoverBtn.type = 'button';
  discoverBtn.className = 'icon-button-wide';
  discoverBtn.textContent = 'Discover from Plex';
  discoverBtn.title = 'Fetches each library\'s real folder path from Plex - requires the Plex URL saved and account linked above';
  discoverBtn.addEventListener('click', async () => {
    discoverBtn.disabled = true;
    try {
      const { paths } = await api.getPlexLibraryPaths();
      removeEmptyPlaceholderRow(pathMapRows);
      const existingFroms = new Set(
        Array.from(pathMapRows.querySelectorAll('[data-field="from"]')).map((el) => el.value.trim())
      );
      let added = 0;
      for (const { path: libraryPath, library } of paths) {
        if (existingFroms.has(libraryPath)) continue;
        pathMapRows.appendChild(renderPathMapRow({ from: libraryPath, to: '', library }));
        added++;
      }
      showToast(
        added
          ? `Found ${added} library folder${added === 1 ? '' : 's'} - fill in the media PC path for each`
          : 'No new library folders found'
      );
    } catch (err) {
      showToast(err.message, true);
    } finally {
      discoverBtn.disabled = false;
    }
  });

  const addRowBtn = document.createElement('button');
  addRowBtn.type = 'button';
  addRowBtn.className = 'icon-button-wide';
  addRowBtn.textContent = '+ Add mapping';
  addRowBtn.addEventListener('click', () => pathMapRows.appendChild(renderPathMapRow({ from: '', to: '' })));

  pathMapSection.append(pathMapHeading, pathMapHint, discoverBtn, pathMapRows, addRowBtn);

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'play-button settings-save';
  saveBtn.textContent = 'Save';

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    saveBtn.disabled = true;
    try {
      await api.saveSettings({
        plexUrl: plexUrlInput.value,
        playerAgentUrl: playerUrlInput.value,
        pathMap: collectPathMap(pathMapRows),
        ...(adminPinInput.value ? { newAdminPin: adminPinInput.value } : {}),
      });
      if (adminPinInput.value) {
        settings.adminPinConfigured = true;
        adminPinInput.value = '';
        adminPinInput.required = false;
        adminPinInput.placeholder = 'Leave blank to keep the current PIN';
        adminPinLabel.firstChild.textContent = 'Change admin PIN (optional)';
      }
      showToast('Settings saved');
      await refreshPlayerAgentPairing();
      try {
        await buildNav(); // picks up newly-configured/linked Plex libraries without a full reload
      } catch {
        // Nav refresh is best-effort - Save itself already succeeded.
      }
    } catch (err) {
      showToast(err.message, true);
    } finally {
      saveBtn.disabled = false;
    }
  });

  form.append(pathMapSection, connSection, securitySection, saveBtn);
  wrap.append(renderPlexAuthSection(settings.plexLinked), form);
  appEl.appendChild(wrap);
  refreshPlayerAgentPairing();
}
