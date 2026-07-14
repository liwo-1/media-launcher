const { getClientId, setStoredToken } = require('./token-store');
const plex = require('./plex');

function headers() {
  return {
    Accept: 'application/json',
    'X-Plex-Product': 'Media Launcher',
    'X-Plex-Client-Identifier': getClientId(),
  };
}

// Plex's official device-linking flow (the same one Plex Web/mobile apps use): request a PIN,
// have the user enter it at plex.tv/link, then poll until Plex attaches an account token to it.
async function requestPin() {
  // No `strong=true` here: that produces a long code meant for an auth-URL redirect flow, not
  // the short 4-character code plex.tv/link expects the user to type in.
  const response = await fetch('https://plex.tv/api/v2/pins', {
    method: 'POST',
    headers: headers(),
  });
  if (!response.ok) throw new Error(`Failed to request a Plex PIN (${response.status})`);
  const data = await response.json();
  return { id: data.id, code: data.code };
}

async function checkPin(id) {
  const response = await fetch(`https://plex.tv/api/v2/pins/${id}`, { headers: headers() });
  if (!response.ok) throw new Error(`Failed to check the Plex PIN (${response.status})`);
  const data = await response.json();
  if (!data.authToken) return { linked: false };
  setStoredToken(data.authToken);
  plex.setToken(data.authToken);
  return { linked: true };
}

function unlink() {
  setStoredToken(null);
  plex.setToken(null);
}

module.exports = { requestPin, checkPin, unlink };
