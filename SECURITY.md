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

The add-on authenticates playback calls to every paired agent with a separate random bearer
secret. Agents also accept only configured media roots and common media extensions. `/health` is
intentionally unauthenticated and reports only basic availability and protocol support; the add-on
uses authenticated endpoints when deciding whether a playback target is online.

## Initial setup and secret handling

- The admin PIN is disabled by default and pairing never depends on it. Enable it if direct port
  8088 is available to devices whose users should not change configuration or relink Plex. An
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
- The browser stores the admin PIN in `localStorage`. Anyone with access to that browser profile can
  administer Media Launcher.
- The Plex token, hashed admin PIN, and private `agents.json` registry are stored in the add-on's
  persistent `/data` directory with restrictive file permissions. Agent-side secrets and player
  profiles are stored under `%LocalAppData%\MediaLauncherPlayerAgent`.
- The secret is not returned to the browser or shown in either settings interface. Existing
  manually paired installations retain their stored key during upgrade.
- Custom player profiles are configured locally on the agent. The add-on sends an opaque saved
  player ID, validated media path, and untrusted display/resume metadata. Executables are started
  directly with tokenized arguments, so metadata cannot create extra arguments; `cmd.exe`,
  PowerShell, script hosts, and shell interpretation are not allowed. Only configure an executable
  you trust—local custom profiles intentionally authorize it to process those arguments.

For additional defense, use host firewalls to allow player port 7777 only from the Home Assistant
host and limit add-on port 8088 to the household network.

## Reporting a vulnerability

Do not publish active credentials, tokens, private media paths, or a working exploit in a public
issue. Contact the maintainer at `contact@liwo.dk` with a description, affected version, impact,
and reproduction steps. Revoke any Plex token that may have been exposed.
