# Roadmap

The beta catalogue is the integration track. Stable remains unchanged until a beta milestone has
been installed and exercised in Home Assistant with real media and player processes.

## Milestone 1 — Playback-target foundation (`1.8.0-beta.1`)

- [x] Backward-compatible agent capability/session negotiation
- [x] Private multi-agent registry and singleton migration
- [x] One pairing secret and path map per agent
- [x] Playback target picker, friendly device names, and default target
- [x] Device removal/revocation, bounded silent enrollment, and retry-safe key exchange
- [x] Concurrent agent-scoped monitoring and player-target-preserving auto-next
- [x] Authenticated reachability checks and file-bound progress monitoring
- [x] Windows detection for MPC-HC, VLC, and PotPlayer
- [x] Safe local custom executable/argument profiles
- [x] Replacement-safe single-session process ownership in the Windows agent
- [x] Add-on protocol, registration, migration, dispatch, and monitor regression tests
- [ ] Real-device beta validation with two agents and more than one installed player

## Milestone 2 — Media-provider boundary and Jellyfin

- [x] Normalize the media model used by routes and the frontend
- [x] Wrap existing Plex behavior in a provider implementation without changing output
- [x] Add Jellyfin server authentication, libraries, browsing, artwork, and search
- [x] Add Jellyfin watched state, resume progress, recently added, and continue watching
- [x] Keep provider credentials private and migrate Settings to a Media Server selector
- [x] Add provider contract fixtures and integration tests
- [ ] Real-server beta validation against both Plex and Jellyfin with movies and episodic playback

## Milestone 3 — Rich player integrations

- [x] Add VLC status/progress through a localhost-only authenticated control interface
- [x] Validate whether PotPlayer exposes a reliable supported status mechanism
- [x] Add capability-gated pause, seek, stop, and session end reasons
- [x] Add locally managed custom-profile validation and diagnostics

## Milestone 4 — Linux agent

- [x] Extract protocol, authentication, session, and player contracts into a platform-neutral core
- [x] Build a Linux user-session agent with systemd user-service packaging
- [x] Discover executables, desktop entries, Flatpak, and Snap profiles
- [x] Add mpv JSON IPC with a private Unix socket
- [x] Add VLC and generic MPRIS adapters
- [x] Support Linux mount-path mappings and allowed-root validation
- [x] Automate Linux x64 and arm64 artifact publishing with checksums

## Milestone 5 — Release engineering

- [x] Add agent unit/integration tests and protocol compatibility fixtures
- [x] Add browser behavior tests for target selection and Settings recovery flows
- [x] Validate self-contained published artifacts in CI
- [x] Automate prerelease tags, checksums, and GitHub release assets
- [x] Add a deterministic beta-to-stable promotion command
- [ ] Promote only after Home Assistant, Windows, and Linux manual acceptance checks pass
