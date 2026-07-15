# Release engineering

The beta catalogue is the release candidate. The stable app is generated from a tested beta tree;
it is not maintained by copying selected files or resolving drift by hand.

## Publish a prerelease

1. Commit the complete candidate on `beta`. Ensure `addon-beta/config.yaml`, the beta app package
   files, both agent projects, and `CHANGELOG.md` contain the intended prerelease versions.
2. Let CI pass, including the protocol contract harness and self-contained artifact validation.
3. Merge or fast-forward that exact candidate into `main` **without changing `addon/`** and let CI
   pass on `main`. Push `main` before testing: Home Assistant reads the two-card catalogue from the
   repository's default branch, not from the `beta` Git branch.
4. Confirm the **Media Launcher Beta** card on Home Assistant now reports the candidate version.
5. Dispatch **Publish prerelease**, selecting the `beta` branch as the run reference. Enter the exact
   beta app version and the confirmation `publish-prerelease`.

The workflow file must already exist on the default `main` branch before GitHub will offer it for a
manual dispatch. The run itself deliberately targets `beta`; its candidate commit must remain an
ancestor of `main`, with the shipped source trees unchanged.

The workflow re-runs the beta and release tests, builds the Home Assistant image, publishes and
validates every self-contained agent binary, and refuses to replace an existing tag or release.
Linux archives are assembled with normalized ownership, timestamps, ordering, and compression.
It creates `v<app-version>` and uploads:

- the versioned Windows executable;
- deterministic Linux x64 and arm64 archives containing the executable, installer, uninstaller,
  example configuration, systemd user unit, and README;
- `SHA256SUMS.txt`; and
- `acceptance-<app-version>.json`, tied to the exact candidate commit and initially failing closed.

The checksum manifest covers all three platform assets and the acceptance record. The record also
names the exact Windows and Linux versions and assets that must be used for manual acceptance.

Tags and release assets are immutable. Bump the prerelease number for any correction.

## Record manual acceptance

Download all assets and verify the release's `SHA256SUMS.txt`. Preserve the downloaded fail-closed
acceptance JSON as the checksummed original, then make a separate copy outside the repository for
the completed record. Editing that copy necessarily changes its checksum; this is expected. Never
replace the immutable release asset or rename the binaries and archives used for testing.

In the copy, fill in `passed`, `testedBy`, `testedAt`, and useful notes for all three gates.
`testedAt` must be a real UTC timestamp in `YYYY-MM-DDTHH:mm:ssZ` form (fractional seconds are also
accepted). Do not change the candidate version, candidate commit, target version, artifact versions,
or asset filenames: stable promotion verifies all of them against the repository candidate.

- **Home Assistant:** from the candidate now present on `main`, perform a fresh install and an
  upgrade of the beta card; exercise Settings recovery and artwork; browse and play real movies and
  episodes from both Plex and Jellyfin; pair two agents with more than one available player and
  verify both the default-target and always-ask flows.
- **Windows:** install and upgrade the exact published executable; pair, reset, and re-pair; exercise
  MPC-HC, VLC, PotPlayer, and a custom profile where available; verify session replacement/ownership;
  and with VLC verify status/progress, pause/resume, seek, stop, and the reported end reason.
- **Linux:** install and upgrade the exact x64 and arm64 archives where hardware is available;
  verify the systemd user service restarts and pairs; exercise native mpv and VLC/generic MPRIS;
  verify status and controls; and confirm allowed-root and symlink path rejection.

The checked-in [acceptance-template.json](acceptance-template.json) documents the schema only. It is
deliberately invalid until populated; the release-generated record is preferred because it already
contains the immutable candidate identity.

## Promote beta to stable

Use a clean `main` worktree containing the already-merged candidate. The accepted commit must remain
an ancestor of `main`. Git must report that `addon-beta/`, `agent-core/`, `player-agent-app/`,
`linux-agent/`, and `protocol/` are byte-identical to that accepted commit; any shipped-code drift
requires a new prerelease and a new acceptance run. Keep the completed acceptance JSON outside the
worktree so the clean-tree guard remains meaningful.

Preview the deterministic output (this never edits `addon/`):

```powershell
node scripts/promote-beta-to-stable.js `
  --version 2.0.0 `
  --acceptance C:\release-records\acceptance-2.0.0-beta.1.json
```

After reviewing the reported tree digest, perform the guarded write:

```powershell
node scripts/promote-beta-to-stable.js `
  --version 2.0.0 `
  --acceptance C:\release-records\acceptance-2.0.0-beta.1.json `
  --write `
  --confirm PROMOTE_BETA_TO_STABLE
```

Writing mode replaces only `addon/` with the generated beta tree, transforms the stable name, slug,
version, panel title, and direct port, and then runs the catalogue check. It excludes dependencies,
local data, build output, and symbolic links. The command also refuses an artifact identity mismatch
or a loose/invalid acceptance timestamp. Review and commit the resulting stable diff normally; the
command never commits, tags, pushes, or publishes by itself.
