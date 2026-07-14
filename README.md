# Media Launcher

A Plex-like poster-grid browser for movies and TV, backed by your existing Plex server for
metadata and watched state. Clicking Play sends the file directly to a paired playback device;
MPC-HC, VLC, PotPlayer, and safe custom Windows launch profiles are available in the current beta.
The player reads from the NAS, Plex is never involved in actual playback, and nothing about the
existing Plex library is modified.

Visually styled after Plex's own web client (dark theme, amber accent, ambient background color
wash generated from each item's actual Plex-computed `UltraBlurColors`, poster season-count badges,
Cast & Crew row, rating badges, per-stream video/audio/subtitle spec line). Also reads Plex's
existing watch-progress data (`/library/onDeck`, `viewedLeafCount`/`leafCount`) to show a "Continue
Watching" row and per-show progress, and can write progress *back* to Plex from playback started
through this launcher (see "Playback monitoring" below) - not building a separate tracking system,
just using Plex's own.

## Release channels

Add this repository once in Home Assistant:

`https://github.com/liwo-1/media-launcher`

The App Store shows two independently installable cards from that one catalogue:

- **Media Launcher** - stable releases, direct port `8088` by default.
- **Media Launcher Beta** - prerelease builds, direct port `8089` by default.

Each app has its own slug, configuration, and persistent data. They can be installed together, but
the Windows player agent keeps one active add-on URL and pairing at a time. Use the matching beta
agent release when testing beta features. Development continues on the `beta` Git branch; tested
beta app snapshots are published to `addon-beta/` on `main` so Home Assistant can display both
channels in the same catalogue. Immediately after a stable promotion both cards share the same
tested baseline; the beta card diverges again when the next prerelease begins.

## Two pieces

- **`addon/`** - stable Home Assistant app package. Talks to your existing Plex server's API,
  serves the custom frontend, and resolves "Play" clicks to a Windows UNC path.
- **`addon-beta/`** - beta Home Assistant app snapshot with an independent slug, port, and data
  directory. Its source is promoted from the `beta` branch without changing the stable package.
- **`player-agent-app/`** - a Windows executable installed on each playback PC. Displays the
  add-on's UI itself in a fullscreen kiosk window (via WebView2 - no separate browser process to
  launch), and runs a small local HTTP server that receives authenticated, target-specific playback
  sessions and starts the selected local media player.
  Superseded the original `player-agent/` Node.js version + PowerShell scheduled-task scripts,
  which no longer need installing.

### player-agent-app features

- **First-run Settings dialog** - Home Assistant add-on URL, player agent port, automatic pairing
  status, allowed UNC media roots, player discovery/custom profiles, and "Start with Windows".
  Reopen any time from the tray icon.
- **Player auto-detection** - checks registry entries, Windows App Paths, `PATH`, and normal install
  locations for MPC-HC, VLC, and PotPlayer. Portable installs can use path overrides.
- **Safe custom players** - configure an executable, optional working directory, and one argument
  template per token. Placeholders are expanded without invoking a shell.
- **Log tab** inside Settings - shows the log from
  `%LocalAppData%\MediaLauncherPlayerAgent\` without needing to dig through the file system. Every
  playback/status request and its outcome is logged there.
- **Tray icon** (Reload / Settings / Exit) - closing the window (Alt+F4, taskbar X) minimizes to
  tray instead of quitting, since this same process also hosts the `/play` HTTP server the add-on
  depends on. Reload force-clears WebView2's cache first, so it always picks up the add-on's latest
  JS/CSS rather than a possibly-stale cached copy.
- **Start with Windows** writes a per-user registry Run key - no admin rights needed, unlike
  Scheduled Tasks (which is exactly why the old PowerShell scripts used a `schtasks.exe` workaround
  in the first place).

## Setup order

### 1. Prerequisites

- An existing Plex Media Server (NAS or separate box), already running and with its libraries
  scanned/matched. Just need a token and its reachable address.
- At least one supported media player on each playback PC. MPC-HC provides full progress and
  auto-next support; VLC, PotPlayer, and custom profiles are launch-only in `1.8.0-beta.1`.
- SMB access from the media PC to the NAS export, with saved credentials so opening a UNC path never
  prompts for auth.
- .NET 8 SDK on whichever machine builds `player-agent-app` (not needed on the media PC itself -
  the published exe is self-contained).
- Microsoft Edge WebView2 Runtime on the media PC (included with current Windows 10/11 and Edge;
  install it separately if the kiosk window reports that WebView2 is unavailable).

### 2. player-agent-app (media PC)

Download the prebuilt exe from
[Releases](https://github.com/liwo-1/media-launcher/releases) (`MediaLauncherPlayerAgent.exe`), or
build it yourself:

```powershell
cd player-agent-app
dotnet publish -c Release
```

(output: `bin\Release\net8.0-windows\win-x64\publish\MediaLauncherPlayerAgent.exe`)

Copy just that one file to the media PC and run it. First launch shows the Settings dialog. Fill in:

- The Home Assistant add-on URL from step 3, e.g. `http://<ha-host-ip>:8088`.
- Every UNC root the player may open, one per line, e.g. `\\nas-host\share\Movies`.

The player starts unpaired and rejects playback until registration succeeds. It contacts only the
Home Assistant add-on URL entered above (no LAN scan or multicast discovery), and retries until the
add-on is available. Before first contact it persists a random enrollment key, making registration
safe to retry even if the first response is lost. The add-on learns the player's source address and
remembers its persistent installation ID. Each installation receives its own record and secret and
cannot replace another device.

Use **Remove device** in the add-on Settings to revoke a retired installation. That identity cannot
silently return; choose **Reset pairing** locally to rotate its identity before enrolling it again.
Resetting locally first is also safe, but the old offline card remains until removed in the add-on.

The player rejects URLs, local paths, paths outside these roots, and unsupported media extensions.

To update later: exit the running instance from its tray icon first (Windows won't let you
overwrite a running exe), then drop the new build in the same folder with the same filename -
configuration in `%LocalAppData%\MediaLauncherPlayerAgent\` and the "Start with Windows" registry
entry both keep working untouched. Existing `config.json` and logs beside an older executable are
migrated automatically on first launch.

When using MPC-HC, **also enable its Web Interface** (View → Options → Player → Web Interface → check "Listen on
port", default 13579) - needed for playback monitoring (progress reporting back to Plex + auto-play
next episode, see below). Confirm it's working by opening
`http://localhost:13579/variables.html` directly in a browser while something's playing - it should
show simple `<p id="...">` tags for `file`/`state`/`position`/`duration`. `MpcStatus.cs` assumes
this shape but hasn't been verified against a real install yet - if the real output looks
different, adjust the field list there.

### 3. media-launcher add-on (Home Assistant)

1. Install: Settings → Apps → App Store → ⋮ (top right) → Repositories → add
   `https://github.com/liwo-1/media-launcher` → refresh. Choose **Media Launcher** for stable or
   **Media Launcher Beta** for prerelease testing, then Install and Start. The direct host ports
   default to `8088` for stable and `8089` for beta; both containers listen on `8088` internally.
2. Open its web UI (Ingress panel in the HA sidebar, or `http://<ha-host-ip>:8088` directly) - with
   nothing configured yet it lands straight on the **Settings** page. All configuration now lives
   there instead of the add-on's Configuration tab:
   - **Plex Account** - click "Link with Plex", then enter the 4-character code shown at
     [plex.tv/link](https://plex.tv/link) on any device. The add-on polls and stores the token
     itself (in its persistent `/data` storage) - no token to copy-paste.
   - **Library path mapping** - one set per paired device. Click **Discover from Plex** to
     auto-fill the *from* side straight from Plex's own API (one row per physical folder, labeled
     with the library name - handles libraries backed by more than one folder too); only the *to*
     side (the path reachable from that playback PC) needs typing by hand. See the comment
     in `addon/app/src/pathmap.js` for the forward-slash convention, though the Settings form
     itself tolerates either slash direction on the *to* side.
   - **Connections** - set Plex's reachable address, rename paired devices, inspect their detected
     players, select a default playback target, and choose whether playback should always ask.
   - **Security** - the 4-to-12-digit admin PIN is optional. When enabled it protects Settings and
     Plex account linking while normal household browsing and playback remain login-free. It can
     be disabled later, and player pairing never depends on it.
   - Click **Save**.

Test the full chain with a real item before building out the browsing UI further:

```powershell
Invoke-RestMethod -Uri "http://<ha-host-ip>:8088/api/play/<a-real-plex-ratingKey>" -Method Post
```

(Copy a `ratingKey` from Plex Web's URL bar when viewing an item.)

Once the add-on's confirmed working, open player-agent-app's Settings (tray icon) and make sure
pairing says **Paired** and the UNC roots cover every mapped path, then Save - the kiosk view
reloads to show it immediately.
If "Start with Windows" was checked, reboot the media PC and confirm it comes back up fullscreen
on the library grid with no manual steps.

### 4. Phone

From a phone on the same LAN, browse to `http://<ha-host-ip>:8088`. Play should trigger playback on
the TV, not the phone.

## Local dev (without deploying to HA/the media PC)

```powershell
# addon backend + frontend
cd addon\app && npm install && npm start

# player-agent-app (needs Windows + .NET 8 SDK - it's a WinForms/WebView2 app)
cd player-agent-app && dotnet run
```

The addon backend has no options file to create - open `http://localhost:8088` and use the
Settings page, exactly like the real add-on (settings persist to `addon/app/local-data/`, gitignored).
For quick one-off overrides you can also set `PLEX_URL` / `PLEX_TOKEN` / `PLAYER_AGENT_URL` /
`PLAYER_AGENT_SECRET` / `PATH_MAP` / `PORT` before `npm start`. Player-agent and path-map variables
are the legacy singleton compatibility path; registered protocol-v2 agents use their authenticated
source address and per-device mappings instead.

Note: `PATH_MAP` (whether saved via the Settings page or set as an env var) is a JSON array - keep
both `from` and `to` as forward-slash paths (e.g. `"to": "//nas/Movies"`), never literal
backslashes. `pathmap.js` converts to backslashes as the final step.

See [ARCHITECTURE.md](ARCHITECTURE.md) for component/data flow, [SECURITY.md](SECURITY.md) for the
LAN threat model, and [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for common setup failures.

## Playback monitoring

**Confirmed working:** clicking Play resolves the Plex path, maps it to a UNC path, reaches
player-agent-app over the LAN, and launches MPC-HC fullscreen with the right file - for both
movies and TV episodes.

After a successful Play, `src/playback-monitor.js` maintains a cancellable session per target and
polls the authenticated session status every 10s (MPC-HC status is read through its local Web
Interface by `MpcStatus.cs`). It:

- Reports position/state back to Plex (`/:/timeline`) - makes progress from playback through this
  launcher show up in Plex's own "Continue Watching"/on-deck data, not just plays through Plex's
  own apps.
- Marks the item watched (`/:/scrobble`) once past 90% - the same threshold Plex/most clients use.
- If it was a TV episode, automatically starts the next episode only after playback transitions to
  stopped near the end; reaching 90% while still playing no longer cuts off the final 10%.
- Replaces only the previous monitor on the same target and tolerates two transient status failures.
- Stops a monitor if the player reports a different file, preventing progress or watched state from
  being attributed to the wrong Plex item after manual player changes.
- If MPC-HC is closed early, stops polling without auto-advance.

The state machine and path-boundary behavior have automated tests. End-to-end status parsing and
auto-advance still require confirmation against a real MPC-HC playback session because the Web
Interface output varies by MPC-HC version. Follow the verification steps in
[TROUBLESHOOTING.md](TROUBLESHOOTING.md#playback-monitoring-verification).

## Roadmap

See [ROADMAP.md](ROADMAP.md) for Jellyfin, richer VLC/PotPlayer control, the Linux agent, and release
automation milestones.

### Future enhancement (Plex Pass)

Not built yet:

- **Auto-skip intro** - read Plex's intro marker (`GET /library/metadata/{ratingKey}?includeMarkers=1`)
  and start MPC-HC at the marker's end offset instead of 0:00.
