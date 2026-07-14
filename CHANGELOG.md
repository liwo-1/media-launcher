# Changelog

## Catalogue update — 2026-07-14

- Added stable and beta as two separately installable Home Assistant apps in the default
  repository catalogue.
- Assigned the beta app its own slug, persistent data, panel title, and default host port `8089`.
- Kept the stable app on `1.6.0` while publishing the tested beta snapshot as `1.7.0-beta.1`.

## 1.6.0 — 2026-07-14

- Added silent, one-time pairing between the Home Assistant add-on and Windows player agent.
- Made the unpaired player fail closed for `/play` and `/status`; remote requests cannot replace
  an established pairing, and recovery requires a local reset in the Windows Settings dialog.
- Removed shared-secret display, copying, regeneration, and manual entry from both settings UIs.
- Reordered Settings to Plex Account, Library Path Mapping, Connections, then Security.
- Styled the admin-PIN password field consistently with the dark application theme.

## 1.5.0 — 2026-07-13

- Added admin-PIN protection for Settings and Plex account linking.
- Added bearer authentication and UNC-root/media-extension validation to the Windows player.
- Reworked playback monitoring into one cancellable session; watched marking no longer triggers
  early auto-advance, and transient status failures are tolerated.
- Fixed playback monitoring to use the player URL saved on the Settings page.
- Added atomic JSON persistence, streamed image proxy responses, and proxied cast thumbnails.
- Moved Windows configuration and logs to LocalAppData with migration from the executable folder.
- Added tests, CI, security/architecture/troubleshooting documentation, and an MIT license.

## 1.4.x — 2026-07-13

- Published the self-contained .NET/WebView2 player-agent and retired the unpublished Node agent.
- Added dynamic navigation for all Plex movie/TV libraries and automatic library-path discovery.
- Fixed Home Assistant Ingress-relative API paths and movie detail button event handling.

## 1.1.0–1.3.x — 2026-07-13

- Moved configuration into an in-app Settings page backed by persistent `/data` storage.
- Added Plex PIN linking, Home Assistant Ingress, and direct-port kiosk/phone access.

## 1.0.0 — 2026-07-13

- Initial Media Launcher Home Assistant add-on.
