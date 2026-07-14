# Changelog

## 1.8.0-beta.1 — 2026-07-15

- Added a private multi-agent registry with one secret per agent and automatic migration from the
  existing single-agent configuration without re-pairing.
- Added opaque playback targets, a themed target picker, a configurable default target, and an
  **Always ask where to play** option.
- Added separate library path mappings and friendly names for every paired playback device.
- Made playback monitoring concurrent across devices. Starting playback in one room no longer
  cancels monitoring in another, and automatic next-episode playback stays on its original target.
- Added additive protocol-v2 capability and session negotiation while preserving protocol-v1
  compatibility with stable add-ons and older agents.
- Added automatic Windows discovery for MPC-HC, VLC, and PotPlayer, plus safe local custom-player
  profiles with tokenized argument templates and no shell execution.
- Added VLC and PotPlayer launch support. MPC-HC retains progress, watched-state, and auto-next
  integration; other players are explicitly advertised as launch-only for this beta.
- Added protected device removal and revocation, bounded/rate-limited silent enrollment, retry-safe
  first registration, authenticated target health checks, and agent-registry backup recovery.
- Made playback launches idempotent across a lost v2 response, kept monitors on refreshed agent
  addresses, and stopped progress tracking when the player reports a different file.
- Enforced one owned local player process at a time, made replacement exit handling session-safe,
  honored fullscreen options, validated built-in player overrides, and added dual-stack listening.
- Added pending-pairing recovery, unavailable/launch-only player labels, incomplete-map validation,
  and a protected **Remove device** action to Settings.
- Updated the Windows player agent to `1.4.0-beta.1` and the beta Home Assistant app to
  `1.8.0-beta.1`.

## 1.7.0 — 2026-07-14

- Made the admin PIN optional, including an explicit **Disable admin PIN** action for existing
  installations. When enabled, it still protects Settings and Plex account linking.
- Removed the player pairing flow from the admin-PIN gate.
- Added directed, zero-touch registration: the Windows agent contacts only its configured Home
  Assistant add-on URL, and the add-on learns the agent address and exchanges the secret.
- Bound registration to a persistent random agent installation ID. The same installation can
  recover its pairing, while a different installation cannot silently replace it.
- Kept the existing add-on-to-agent `/pair` flow as a compatibility fallback.
- Promoted Windows player agent `1.3.0` and synchronized stable and beta to this baseline.

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
