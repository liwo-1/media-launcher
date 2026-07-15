# Media Launcher

A poster-grid browser for movies and TV, backed by your existing Plex or Jellyfin server for
metadata and watched state. Clicking Play sends the file directly to a paired playback device;
the current beta supports MPC-HC, VLC, PotPlayer, and safe custom profiles on Windows, plus mpv,
VLC/MPRIS, discovered desktop applications, and safe custom profiles on Linux.
The player reads from the NAS; the media server supplies metadata, source paths, and watch state
but does not transcode or stream the launched file.

The dark, amber-accented UI includes ambient artwork, season and watched-count badges, cast, ratings,
stream details, recently added, search, and continue watching. Progress from monitored playback is
written back to the selected provider instead of creating a separate tracking database.

## Release channels

Add this repository once in Home Assistant:

`https://github.com/liwo-1/media-launcher`

The App Store shows two independently installable cards from that one catalogue:

- **Media Launcher** - stable releases, direct port `8088` by default.
- **Media Launcher Beta** - prerelease builds, direct port `8089` by default.

Each app has its own slug, configuration, and persistent data. They can be installed together, but
each player agent keeps one active add-on URL and pairing at a time. Use the matching beta
agent release when testing beta features. Development continues on the `beta` Git branch; a release
candidate must also be merged into `addon-beta/` on `main` before Home Assistant can display and test
it in the two-card catalogue. Immediately after a stable promotion both cards share the same tested
baseline; the beta card diverges again when the next prerelease begins.

## Two pieces

- **`addon/`** - stable Home Assistant app package. Talks to your existing Plex server's API,
  serves the custom frontend, and resolves "Play" clicks to a Windows UNC path.
- **`addon-beta/`** - beta Home Assistant app snapshot with an independent slug, port, and data
  directory. Beta `2.0.0` can use Plex or Jellyfin and Windows or Linux players; its source is promoted from the `beta` branch
  without changing the stable package.
- **`agent-core/`** - platform-neutral .NET protocol, authentication, capability, path-policy, and
  player contracts shared by both agents.
- **`player-agent-app/`** - a Windows executable installed on each playback PC. Displays the
  add-on's UI itself in a fullscreen kiosk window (via WebView2 - no separate browser process to
  launch), and runs a small local HTTP server that receives authenticated, target-specific playback
  sessions and starts the selected local media player.
  Superseded the original `player-agent/` Node.js version + PowerShell scheduled-task scripts,
  which no longer need installing.
- **`linux-agent/`** - a self-contained Linux user-session service. It discovers native, desktop,
  Flatpak, Snap, and custom player profiles and accepts the same authenticated session protocol.

### Windows player-agent features

- **First-run Settings dialog** - Home Assistant add-on URL, player agent port, automatic pairing
  status, allowed UNC media roots, player discovery/custom profiles, and "Start with Windows".
  Reopen any time from the tray icon.
- **Player auto-detection** - checks registry entries, Windows App Paths, `PATH`, and normal install
  locations for MPC-HC, VLC, and PotPlayer. Portable installs can use path overrides.
- **Rich VLC integration** - each session gets a random password and numeric loopback-only control
  endpoint for status, pause/resume, seek, and stop. MPC-HC retains status/progress; PotPlayer is
  deliberately launch-and-stop only because it has no documented reliable status interface.
- **Safe custom players** - configure a local executable, optional working directory, and one
  argument template per token. Placeholders are expanded without invoking a shell, and invalid
  profiles report local diagnostics instead of being advertised as usable.
- **Log tab** inside Settings - shows the log from
  `%LocalAppData%\MediaLauncherPlayerAgent\` without needing to dig through the file system. Every
  agent lifecycle and playback outcomes are logged there without recording pairing secrets.
- **Tray icon** (Reload / Settings / Exit) - closing the window (Alt+F4, taskbar X) minimizes to
  tray instead of quitting, since this same process also hosts the `/play` HTTP server the add-on
  depends on. Reload force-clears WebView2's cache first, so it always picks up the add-on's latest
  JS/CSS rather than a possibly-stale cached copy.
- **Start with Windows** writes a per-user registry Run key - no admin rights needed, unlike
  Scheduled Tasks (which is exactly why the old PowerShell scripts used a `schtasks.exe` workaround
  in the first place).

## Setup order

### 1. Prerequisites

- An existing Plex server, or Jellyfin 10.10.7 or newer, already running with movie/TV libraries.
  Jellyfin items must expose filesystem-backed media sources for direct-file launching.
- At least one supported media player on each playback device. Windows VLC and Linux mpv provide
  full status and transport controls. Linux VLC/generic MPRIS control requires `playerctl`.
  PotPlayer and profiles without a supported status interface are launch-and-stop only.
- Windows devices need SMB access to the NAS export with saved credentials. Linux devices need the
  media mounted at stable absolute paths visible to the user service.
- .NET 8 SDK on whichever machine builds `player-agent-app` (not needed on the media PC itself -
  the published exe is self-contained).
- Microsoft Edge WebView2 Runtime on the media PC (included with current Windows 10/11 and Edge;
  install it separately if the kiosk window reports that WebView2 is unavailable).

### 2a. Windows player agent

Download the prebuilt exe from
[Releases](https://github.com/liwo-1/media-launcher/releases)
(`MediaLauncherPlayerAgent-<version>-win-x64.exe`), or build it yourself:

```powershell
cd player-agent-app
dotnet publish -c Release
```

(output: `bin\Release\net8.0-windows\win-x64\publish\MediaLauncherPlayerAgent.exe`)

Copy just that one file to the media PC, optionally rename it to the stable local filename
`MediaLauncherPlayerAgent.exe`, and run it. First launch shows the Settings dialog. Fill in:

- The matching Home Assistant add-on URL from step 3: normally `http://<ha-host-ip>:8088` for
  stable or `http://<ha-host-ip>:8089` for beta.
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

The Windows player rejects URLs, local paths, paths outside these UNC roots, and unsupported media
extensions.

To update later: exit the running instance from its tray icon first (Windows won't let you
overwrite a running exe), rename the new versioned download to the same local filename, then replace
the old file. Configuration in `%LocalAppData%\MediaLauncherPlayerAgent\` and the "Start with
Windows" registry entry both keep working untouched. Existing `config.json` and logs beside an
older executable are migrated automatically on first launch.

When using MPC-HC, **also enable its Web Interface** (View → Options → Player → Web Interface → check "Listen on
port", default 13579) - needed for playback monitoring (provider progress + auto-play
next episode, see below). Confirm it's working by opening
`http://localhost:13579/variables.html` directly in a browser while something's playing - it should
show simple `<p id="...">` tags for `file`/`state`/`position`/`duration`. `MpcStatus.cs` assumes
this shape but hasn't been verified against a real install yet - if the real output looks
different, adjust the field list there.

### 2b. Linux player agent

Download the matching `linux-x64` or `linux-arm64` archive from
[Releases](https://github.com/liwo-1/media-launcher/releases), extract it as your desktop user, and
run:

```sh
./install.sh
~/.local/lib/media-launcher-agent/media-launcher-linux-agent configure \
  --home-assistant-url http://HA-HOST:8089 \
  --allowed-root /mnt/media
systemctl --user enable --now media-launcher-agent.service
```

Repeat `--allowed-root` for every mounted destination used in that device's Home Assistant path
mappings. Pairing is directed to the configured add-on URL and remains independent of the optional
admin PIN. `diagnose` lists discovered players and actionable profile diagnostics without printing
secrets. Native mpv uses a private Unix socket; VLC and generic MPRIS integrations use `playerctl`
when available. See [linux-agent/README.md](linux-agent/README.md) for service, custom-profile, and
reset instructions.

### 3. media-launcher add-on (Home Assistant)

1. Install: Settings → Apps → App Store → ⋮ (top right) → Repositories → add
   `https://github.com/liwo-1/media-launcher` → refresh. Choose **Media Launcher** for stable or
   **Media Launcher Beta** for Jellyfin, Linux-agent, and prerelease testing, then Install and Start. The direct
   host ports default to `8088` for stable and `8089` for beta; both containers listen on `8088`
   internally.
2. Open the matching web UI (Ingress panel in the HA sidebar, `http://<ha-host-ip>:8088` for stable,
   or `http://<ha-host-ip>:8089` for beta). With nothing configured, it lands on **Settings**. The
   Media Server selector and Jellyfin flow below are beta features; stable remains Plex-only.
   Configuration lives in the app instead of the add-on's Configuration tab:
   - **Media Server** - choose Plex or Jellyfin and enter its address. Plex uses the code shown at
     [plex.tv/link](https://plex.tv/link). Jellyfin uses a normal username/password sign-in; the
     password is never stored, only the returned user token. Jellyfin 10.10.7 or newer is required.
   - **Library path mapping** - one set per paired device. Click **Discover from media server** to
     auto-fill the *from* side (one row per physical folder, labeled with its library); only the *to*
     side (the UNC path or Linux mount path reachable from that playback device) needs typing by hand. Jellyfin path discovery
     and scans require an administrator account. See the comment
     in `addon/app/src/pathmap.js` for the forward-slash convention, though the Settings form
     itself tolerates either slash direction on the *to* side.
   - **Connections** - rename paired devices, inspect their detected players, select a default
     playback target, and choose whether playback should always ask.
   - **Security** - the 4-to-12-digit admin PIN is optional. When enabled it protects Settings and
     media-account linking while normal household browsing and playback remain login-free. It can
     be disabled later, and player pairing never depends on it.
   - Click **Save**.

Test the full chain with a real item before building out the browsing UI further:

```powershell
Invoke-RestMethod -Uri "http://<ha-host-ip>:<port>/api/play/<a-real-item-id>" -Method Post
```

(Use port `8088` for stable or `8089` for beta and the active provider's item ID; the browser's
Play button is the easier end-to-end test.)

Once the add-on's confirmed working, open player-agent-app's Settings (tray icon) and make sure
pairing says **Paired** and the UNC roots cover every mapped path, then Save - the kiosk view
reloads to show it immediately.
If "Start with Windows" was checked, reboot the media PC and confirm it comes back up fullscreen
on the library grid with no manual steps.

### 4. Phone

From a phone on the same LAN, browse to the matching direct port (`8088` stable or `8089` beta).
Play should trigger playback on the TV, not the phone.

## Local dev (without deploying to HA/the media PC)

```powershell
# beta add-on backend + frontend
cd addon-beta\app && npm install && npm start

# player-agent-app (needs Windows + .NET 8 SDK - it's a WinForms/WebView2 app)
cd player-agent-app && dotnet run

# Linux agent (configure a private test config first; the executable itself runs only on Linux)
cd linux-agent && dotnet build
```

The add-on backend has no options file to create - open `http://localhost:8088` and use the
Settings page, exactly like the real add-on (settings persist to `addon-beta/app/local-data/`,
gitignored).
For quick one-off overrides you can also set `MEDIA_PROVIDER`, `PLEX_URL` / `PLEX_TOKEN`, or
`JELLYFIN_URL` / `JELLYFIN_ACCESS_TOKEN` / `JELLYFIN_USER_ID`, plus `PLAYER_AGENT_URL` /
`PLAYER_AGENT_SECRET` / `PATH_MAP` / `PORT` before `npm start`. Player-agent and path-map variables
are the legacy singleton compatibility path; registered protocol-v2 agents use their authenticated
source address and per-device mappings instead. Jellyfin environment credentials must include the
exact matching `JELLYFIN_URL` and a user ID. `PLEX_TOKEN` likewise requires the exact matching
`PLEX_URL`; changing a saved Plex URL requires relinking so a token cannot follow an unintended
server address. A Plex link saved by an older beta did not contain that server scope and therefore
requires a one-time relink after upgrading to `2.0.0-beta.1`.

Note: `PATH_MAP` (whether saved via the Settings page or set as an env var) is a JSON array - keep
both `from` and `to` as forward-slash paths (e.g. `"to": "//nas/Movies"`), never literal
backslashes. `pathmap.js` converts to backslashes as the final step.

See [ARCHITECTURE.md](ARCHITECTURE.md) for component/data flow, [SECURITY.md](SECURITY.md) for the
LAN threat model, and [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for common setup failures.

## Playback monitoring

**Confirmed Plex baseline:** clicking Play resolves the provider path, maps it to a UNC path, reaches
player-agent-app over the LAN, and launches MPC-HC fullscreen with the right file - for both
movies and TV episodes. Jellyfin support in `2.0.0-beta.1` has automated provider/route coverage
and still needs the real-server beta validation listed in the roadmap.

After a successful Play, `src/playback-monitor.js` maintains one cancellable session per physical
agent and retains its selected player target for controls and auto-next. It
polls the authenticated session status every 10s. MPC-HC uses its local Web Interface, Windows VLC
uses its private authenticated loopback endpoint, Linux mpv uses private JSON IPC, and controlled
Linux players use MPRIS. It:

- Reports position/state back to Plex or Jellyfin so playback through this launcher appears in the
  provider's own continue-watching data.
- Marks the provider item watched once past 90%.
- If it was a TV episode, automatically starts the next episode only after playback transitions to
  stopped near the end; reaching 90% while still playing no longer cuts off the final 10%.
- Replaces only the previous monitor on the same physical agent and tolerates two transient status failures.
- Stops a monitor if the player reports a different file, preventing progress or watched state from
  being attributed to the wrong provider item after manual player changes.
- If MPC-HC is closed early, stops polling without auto-advance.

The state machine, transport-control bridge, and path-boundary behavior have automated tests.
End-to-end status parsing and auto-advance still require acceptance against real player processes
and media servers. Follow the verification steps in
[TROUBLESHOOTING.md](TROUBLESHOOTING.md#playback-monitoring-verification).

## Roadmap

The implementation and automated release work for milestones 3–5 is present in beta
`2.0.0-beta.1`; the unchecked items in
[ROADMAP.md](ROADMAP.md) are the real-device/server acceptance gates that cannot be completed in CI.
Maintainers can find the guarded prerelease and beta-to-stable procedures in
[release/README.md](release/README.md); stable promotion stays blocked until its external manual
acceptance record passes every platform gate.

### Future enhancement (Plex Pass)

Not built yet:

- **Auto-skip intro** - read Plex's intro marker (`GET /library/metadata/{ratingKey}?includeMarkers=1`)
  and start MPC-HC at the marker's end offset instead of 0:00.
