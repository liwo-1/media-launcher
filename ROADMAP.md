# Roadmap

The beta catalogue is the integration track. Stable remains unchanged until a beta milestone has
been installed and exercised in Home Assistant with real media and player processes.

## Milestone 1 — Playback-target foundation (`1.8.0-beta.1`)

- [x] Backward-compatible agent capability/session negotiation
- [x] Private multi-agent registry and singleton migration
- [x] One pairing secret and path map per agent
- [x] Playback target picker, friendly device names, and default target
- [x] Device removal/revocation, bounded silent enrollment, and retry-safe key exchange
- [x] Concurrent target-scoped monitoring and target-preserving auto-next
- [x] Authenticated reachability checks and file-bound progress monitoring
- [x] Windows detection for MPC-HC, VLC, and PotPlayer
- [x] Safe local custom executable/argument profiles
- [x] Replacement-safe single-session process ownership in the Windows agent
- [x] Add-on protocol, registration, migration, dispatch, and monitor regression tests
- [ ] Real-device beta validation with two agents and more than one installed player

## Milestone 2 — Media-provider boundary and Jellyfin

- [ ] Normalize the media model used by routes and the frontend
- [ ] Wrap existing Plex behavior in a provider implementation without changing output
- [ ] Add Jellyfin server authentication, libraries, browsing, artwork, and search
- [ ] Add Jellyfin watched state, resume progress, recently added, and continue watching
- [ ] Keep provider credentials private and migrate Settings to a Media Server selector
- [ ] Add provider contract fixtures and integration tests

## Milestone 3 — Rich player integrations

- [ ] Add VLC status/progress through a localhost-only authenticated control interface
- [ ] Validate whether PotPlayer exposes a reliable supported status mechanism
- [ ] Add capability-gated pause, seek, stop, and session end reasons
- [ ] Add locally managed custom-profile validation and diagnostics

## Milestone 4 — Linux agent

- [ ] Extract protocol, authentication, session, and player contracts into a platform-neutral core
- [ ] Build a Linux user-session agent with systemd user-service packaging
- [ ] Discover executables, desktop entries, Flatpak, and Snap profiles
- [ ] Add mpv JSON IPC with a private Unix socket
- [ ] Add VLC and generic MPRIS adapters
- [ ] Support Linux mount-path mappings and allowed-root validation
- [ ] Publish Linux x64 and arm64 artifacts with checksums

## Milestone 5 — Release engineering

- [ ] Add agent unit/integration tests and protocol compatibility fixtures
- [ ] Add browser behavior tests for target selection and Settings recovery flows
- [ ] Validate self-contained published artifacts in CI
- [ ] Automate prerelease tags, checksums, and GitHub release assets
- [ ] Add a deterministic beta-to-stable promotion command
- [ ] Promote only after Home Assistant, Windows, and Linux manual acceptance checks pass
