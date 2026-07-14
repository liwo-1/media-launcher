# Security

## Supported use and threat model

Media Launcher is designed for a trusted home LAN. It does not provide TLS, an Internet-facing
login system, tenant isolation, or protection from an attacker who already controls the Home
Assistant host or Windows media PC. Do not forward ports 8088 or 7777 from a router, publish them
through an unauthenticated reverse proxy, or expose them to a guest/IoT network you do not trust.

The direct add-on UI deliberately keeps ordinary browsing, playback, watched toggles, and library
scans login-free for household kiosk and phone use. An optional admin PIN can protect Settings and
Plex account-linking endpoints. Home Assistant Ingress adds HA authentication, but direct port
8088 does not inherit that authentication.

The add-on authenticates `/play` and `/status` calls to the Windows player with a generated bearer
secret. The player also accepts only configured UNC roots and common media extensions. `/health`
is intentionally unauthenticated and reports only basic availability and pairing state.

## Initial setup and secret handling

- The admin PIN is disabled by default and pairing never depends on it. Enable it if direct port
  8088 is available to devices whose users should not change configuration or relink Plex. An
  existing PIN can be removed with **Disable admin PIN** after authenticating once.
- The agent registers only with its configured add-on URL; it does not scan the LAN or accept an
  identity advertised through mDNS. The add-on derives the player URL from the registration's
  network source and binds the first registration to a random persistent installation ID.
- While unpaired, the player rejects `/play` and `/status`. Registration and the compatibility
  `/pair` endpoint are available without the admin PIN because they exchange the component secret
  directly. Perform first setup on the trusted home LAN: HTTP is not encrypted, and a hostile LAN
  peer could race a brand-new installation before the intended agent registers.
- Later registrations from the same installation recover the existing secret and refresh its IP
  address. A different installation ID is rejected instead of replacing the binding.
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
