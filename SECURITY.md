# Security

## Supported use and threat model

Media Launcher is designed for a trusted home LAN. It does not provide TLS, an Internet-facing
login system, tenant isolation, or protection from an attacker who already controls the Home
Assistant host or a Windows/Linux playback device. Do not forward ports 8088, 8089, or 7777 from a
router, publish them
through an unauthenticated reverse proxy, or expose them to a guest/IoT network you do not trust.

The direct add-on UI deliberately keeps ordinary browsing, playback, watched toggles, and library
scans login-free for household kiosk and phone use. An optional admin PIN can protect Settings and
Plex/Jellyfin account-linking endpoints. Home Assistant Ingress adds HA authentication, but the
direct host port (8088 stable / 8089 beta) does not inherit that authentication.

The add-on authenticates playback calls to every paired agent with a separate random bearer
secret. Windows agents accept only configured UNC roots; Linux agents accept only existing absolute
files whose symlink-resolved paths remain under configured mount roots. Both enforce a common media
extension allowlist. `/health` is
intentionally unauthenticated and reports only basic availability and protocol support; the add-on
uses authenticated endpoints when deciding whether a playback target is online.

## Initial setup and secret handling

- The admin PIN is disabled by default and pairing never depends on it. Enable it if the direct
  host port (8088 stable / 8089 beta) is available to devices whose users should not change
  configuration or relink a media account. An
  existing PIN can be removed with **Disable admin PIN** after authenticating once.
- Every agent registers only with its configured add-on URL; it does not scan the LAN or accept an
  identity advertised through mDNS. The add-on derives each URL from the registration's network
  source and keys the private registry by the agent's random persistent installation ID.
- While unpaired, the player rejects playback and status calls. It persists a random enrollment
  credential before its first registration so retries after a lost response prove the same
  installation. Registration and the compatibility `/pair` endpoint are available without the
  admin PIN because they bootstrap the component secret directly. Perform first setup on the
  trusted home LAN: HTTP is not encrypted.
- Later authenticated registrations from the same installation retain its secret and may refresh
  its IP address. A different installation ID creates an independent agent record and secret; it
  cannot overwrite another device.
- Silent enrollment is capped at 16 active records and rate-limited per source address. This limits
  accidental or hostile registry pollution but is not identity proof against a malicious device on
  the trusted LAN. Remove stale devices in Settings; revocation blocks the old identity until the
  user resets pairing locally, which rotates it.
- The browser keeps an entered admin PIN only in page memory and purges the plaintext local-storage
  value used by older beta builds. Reloading or closing the page forgets it.
- Plex and Jellyfin credentials, the hashed admin PIN, and private `agents.json` registry are stored
  in the add-on's persistent `/data` directory with restrictive file permissions. A Jellyfin
  password is sent only to the verified configured server during sign-in and is never persisted;
  the resulting user token is scoped to that exact normalized server URL. Plex device-link tokens
  are likewise bound to the exact configured Plex URL and require relinking after it changes.
  Agent-side secrets and
  player profiles are stored under `%LocalAppData%\MediaLauncherPlayerAgent` on Windows or
  `~/.config/media-launcher-agent` with user-only permissions on Linux.
- Media-server requests reject redirects so authorization headers cannot be forwarded to a new
  origin. Browser artwork is fetched only from bounded provider-owned paths through opaque
  references; the proxy accepts only raster image types and caps both response size and streaming
  time. Unlinking a media account also stops monitors that captured that provider's credentials.
- The secret is not returned to the browser or shown in either settings interface. Existing
  manually paired installations retain their stored key during upgrade.
- Custom player profiles are configured locally on the agent. The add-on sends an opaque saved
  player ID, validated media path, and untrusted display/resume metadata. Executables are started
  directly with tokenized arguments, so metadata cannot create extra arguments; `cmd.exe`,
  PowerShell, script hosts, and shell interpretation are not allowed. Only configure an executable
  you trust—local custom profiles intentionally authorize it to process those arguments.
- Windows VLC control is bound to numeric `127.0.0.1`, uses a random password per session, sends
  Basic authentication on every local request, and disables proxies and redirects. Linux mpv uses
  a socket inside a user-only runtime directory. Linux MPRIS control runs as the desktop user and is
  therefore intentionally limited to that user's media session.
- The Linux systemd user unit uses a restrictive umask, no-new-privileges, restricted address
  families, and a read-only home view except for standard XDG config/cache/data/state locations and
  common Flatpak/Snap user-state roots required by launched desktop players. It is not a system
  service and never requires root installation; Flatpak/Snap launch compatibility remains a
  distribution-specific manual acceptance item.

For additional defense, use host firewalls to allow player port 7777 only from the Home Assistant
host and limit add-on ports 8088/8089 to the household network.

## Reporting a vulnerability

Do not publish active credentials, tokens, private media paths, or a working exploit in a public
issue. Contact the maintainer at `contact@liwo.dk` with a description, affected version, impact,
and reproduction steps. Revoke any Plex or Jellyfin token that may have been exposed.
