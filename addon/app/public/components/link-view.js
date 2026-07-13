function renderLinkView(pin, onLinked) {
  const wrap = document.createElement('div');
  wrap.className = 'link-view';
  wrap.innerHTML = `
    <h1>Link your Plex account</h1>
    <p>Go to <a href="${pin.linkUrl}" target="_blank" rel="noopener">plex.tv/link</a> on any device
      and enter this code:</p>
    <div class="link-code">${pin.code}</div>
    <p class="link-status">Waiting for confirmation&hellip;</p>
  `;

  const statusEl = wrap.querySelector('.link-status');

  async function poll() {
    try {
      const result = await api.checkPlexPin(pin.id);
      if (result.linked) {
        statusEl.textContent = 'Linked! Loading your library…';
        onLinked();
        return;
      }
    } catch (err) {
      statusEl.textContent = err.message;
    }
    setTimeout(poll, 2000);
  }
  poll();

  return wrap;
}
