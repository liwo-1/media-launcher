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
is intentionally unauthenticated and reports only `{ "ok": true }`.

## Initial setup and secret handling

- Until the first admin PIN is saved, the Settings and Plex-linking endpoints remain open so a new
  installation can be configured. Set the PIN before linking Plex or exposing port 8088 to other
  devices.
- Until a shared secret is entered in the Windows player, its API allows unauthenticated requests
  for first-run compatibility. Copy the generated secret from the add-on immediately.
- The browser stores the admin PIN in `localStorage`. Anyone with access to that browser profile can
  administer Media Launcher.
- The Plex token and hashed admin PIN are stored in the add-on's persistent `/data` directory. The
  player secret and configuration are stored under `%LocalAppData%\MediaLauncherPlayerAgent`.
- Regenerating the player secret invalidates the old value immediately. Update the Windows player
  before attempting playback again.

For additional defense, use host firewalls to allow player port 7777 only from the Home Assistant
host and limit add-on port 8088 to the household network.

## Reporting a vulnerability

Do not publish active credentials, tokens, private media paths, or a working exploit in a public
issue. Contact the maintainer at `contact@liwo.dk` with a description, affected version, impact,
and reproduction steps. Revoke any Plex token that may have been exposed.
