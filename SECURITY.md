# Security

## Supported use and threat model

Media Launcher is designed for a trusted home LAN. It does not provide TLS, an Internet-facing
login system, tenant isolation, or protection from an attacker who already controls the Home
Assistant host or Windows media PC. Do not forward ports 8088 or 7777 from a router, publish them
through an unauthenticated reverse proxy, or expose them to a guest/IoT network you do not trust.

The direct add-on UI deliberately keeps ordinary browsing, playback, watched toggles, and library
scans login-free for household kiosk and phone use. Settings and Plex account-linking endpoints are
protected by an admin PIN. Home Assistant Ingress adds HA authentication, but direct port 8088 does
not inherit that authentication.

The add-on authenticates `/play` and `/status` calls to the Windows player with a generated bearer
secret. The player also accepts only configured UNC roots and common media extensions. `/health`
is intentionally unauthenticated and reports only basic availability and pairing state.

## Initial setup and secret handling

- Until the first admin PIN is saved, the Settings and Plex-linking endpoints remain open so a new
  installation can be configured. Set the PIN before linking Plex or exposing port 8088 to other
  devices.
- While unpaired, the player rejects `/play` and `/status` and accepts exactly one key through
  `/pair`. The add-on sends that key automatically once the player URL is saved. Because pairing
  is silent and HTTP is not encrypted, perform first setup on the trusted home LAN; another LAN
  peer could otherwise race to claim an unpaired agent.
- Once paired, the agent rejects all remote re-pairing. Recovery requires **Reset pairing** in the
  local Windows Settings dialog, after which the add-on can pair once again.
- The browser stores the admin PIN in `localStorage`. Anyone with access to that browser profile can
  administer Media Launcher.
- The Plex token and hashed admin PIN are stored in the add-on's persistent `/data` directory. The
  player secret and configuration are stored under `%LocalAppData%\MediaLauncherPlayerAgent`.
- The secret is not returned to the browser or shown in either settings interface. Existing
  manually paired installations retain their stored key during upgrade.

For additional defense, use host firewalls to allow player port 7777 only from the Home Assistant
host and limit add-on port 8088 to the household network.

## Reporting a vulnerability

Do not publish active credentials, tokens, private media paths, or a working exploit in a public
issue. Contact the maintainer at `contact@liwo.dk` with a description, affected version, impact,
and reproduction steps. Revoke any Plex token that may have been exposed.
