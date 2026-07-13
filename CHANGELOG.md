# Changelog

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
