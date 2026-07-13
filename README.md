# Media Launcher

A Plex-like poster-grid browser for movies and TV, backed by your existing Plex server for
metadata only. Clicking Play launches MPC-HC fullscreen on the media PC, reading the file directly
off the NAS - Plex is never involved in actual playback, and nothing about your existing Plex setup
is modified.

Visually styled after Plex's own web client (dark theme, amber accent, ambient background color
wash generated from each item's actual Plex-computed `UltraBlurColors`, poster season-count badges,
Cast & Crew row, rating badges, per-stream video/audio/subtitle spec line). Also reads Plex's
existing watch-progress data (`/library/onDeck`, `viewedLeafCount`/`leafCount`) to show a "Continue
Watching" row and per-show progress, and can write progress *back* to Plex from playback started
through this launcher (see "Playback monitoring" below) - not building a separate tracking system,
just using Plex's own.

## Two pieces

- **`addon/`** - deployed as a Home Assistant local add-on. Talks to your existing Plex server's
  API, serves the custom frontend, and resolves "Play" clicks to a Windows UNC path.
- **`player-agent-app/`** - a single Windows executable that runs on the media PC. Displays the
  add-on's UI itself in a fullscreen kiosk window (via WebView2 - no separate browser process to
  launch), and runs a small local HTTP server that receives "Play" requests and spawns MPC-HC.
  Superseded the original `player-agent/` Node.js version + PowerShell scheduled-task scripts,
  which no longer need installing.

### player-agent-app features

- **First-run Settings dialog** - Home Assistant add-on URL, player agent port, optional MPC-HC
  path override, "Start with Windows" checkbox. Reopen any time from the tray icon.
- **MPC-HC auto-detection** - checks the Windows registry and default install paths live as you
  open Settings; shows a **Browse...** button and a download link if it can't find MPC-HC.
- **Log tab** inside Settings - shows `player-agent.log` (next to the exe) without needing to dig
  through the file system. Every `/play`/`/status` request and its outcome is logged there.
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
- MPC-HC installed on the media PC ([clsid2's actively-maintained fork](https://github.com/clsid2/mpc-hc/releases/latest) -
  the original sourceforge/codeplex project is dead).
- SMB access from the media PC to the NAS export, with saved credentials so opening a UNC path never
  prompts for auth.
- .NET 8 SDK on whichever machine builds `player-agent-app` (not needed on the media PC itself -
  the published exe is self-contained).

### 2. player-agent-app (media PC)

Download the prebuilt exe from
[Releases](https://github.com/liwo-1/media-launcher/releases) (`MediaLauncherPlayerAgent.exe`), or
build it yourself:

```powershell
cd player-agent-app
dotnet publish -c Release
```

(output: `bin\Release\net8.0-windows\win-x64\publish\MediaLauncherPlayerAgent.exe`)

Copy just that one file to the media PC and run it. First launch shows the Settings dialog; fill in
the Home Assistant add-on URL (step 3 below) once it's up, e.g. `http://<ha-host-ip>:8088`.

To update later: exit the running instance from its tray icon first (Windows won't let you
overwrite a running exe), then drop the new build in the same folder with the same filename -
`config.json` and the "Start with Windows" registry entry both keep working untouched.

**Also enable MPC-HC's Web Interface** (View → Options → Player → Web Interface → check "Listen on
port", default 13579) - needed for playback monitoring (progress reporting back to Plex + auto-play
next episode, see below). Confirm it's working by opening
`http://localhost:13579/variables.html` directly in a browser while something's playing - it should
show simple `<p id="...">` tags for `file`/`state`/`position`/`duration`. `MpcStatus.cs` assumes
this shape but hasn't been verified against a real install yet - if the real output looks
different, adjust the field list there.

### 3. media-launcher add-on (Home Assistant)

1. Install: Settings → Add-ons → Add-on Store → ⋮ (top right) → Repositories → add
   `https://github.com/liwo-1/media-launcher` → refresh → "Media Launcher" appears under the new
   repository section → Install → Start. Check its log for `media-launcher listening on
   0.0.0.0:8088`.
2. Open its web UI (Ingress panel in the HA sidebar, or `http://<ha-host-ip>:8088` directly) - with
   nothing configured yet it lands straight on the **Settings** page. All configuration now lives
   there instead of the add-on's Configuration tab:
   - **Plex server URL** - Plex's reachable address from the HA host (default port 32400, e.g.
     `http://<nas-ip>:32400`).
   - **Player agent URL** - `http://<media-pc-ip>:7777`.
   - **Library path mapping** - one row per library folder. Click **Discover from Plex** to
     auto-fill the *from* side straight from Plex's own API (one row per physical folder, labeled
     with the library name - handles libraries backed by more than one folder too); only the *to*
     side (the Windows UNC path reachable from the media PC) needs typing by hand. See the comment
     in `addon/app/src/pathmap.js` for the forward-slash convention, though the Settings form
     itself tolerates either slash direction on the *to* side.
   - **Plex Account** - click "Link with Plex", then enter the 4-character code shown at
     [plex.tv/link](https://plex.tv/link) on any device. The add-on polls and stores the token
     itself (in its persistent `/data` storage) - no token to copy-paste.
   - Click **Save**.

Test the full chain with a real item before building out the browsing UI further:

```powershell
Invoke-RestMethod -Uri "http://<ha-host-ip>:8088/api/play/<a-real-plex-ratingKey>" -Method Post
```

(Copy a `ratingKey` from Plex Web's URL bar when viewing an item.)

Once the add-on's confirmed working, open player-agent-app's Settings (tray icon) and make sure
the Home Assistant add-on URL matches, then Save - the kiosk view reloads to show it immediately.
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
`PATH_MAP` / `PORT` as env vars before `npm start` - they take priority over whatever's saved.

Note: `PATH_MAP` (whether saved via the Settings page or set as an env var) is a JSON array - keep
both `from` and `to` as forward-slash paths (e.g. `"to": "//nas/Movies"`), never literal
backslashes. `pathmap.js` converts to backslashes as the final step.

## Playback monitoring (partially verified)

**Confirmed working:** clicking Play resolves the Plex path, maps it to a UNC path, reaches
player-agent-app over the LAN, and launches MPC-HC fullscreen with the right file - for both
movies and TV episodes.

**Still unverified:** after a successful Play, `src/playback-monitor.js` polls player-agent-app's
`/status` every 10s (which itself reads MPC-HC's Web Interface via `MpcStatus.cs`) and:

- Reports position/state back to Plex (`/:/timeline`) - makes progress from playback through this
  launcher show up in Plex's own "Continue Watching"/on-deck data, not just plays through Plex's
  own apps.
- Marks the item watched (`/:/scrobble`) once past 90% - the same threshold Plex/most clients use.
- If it was a TV episode, automatically starts the next episode in the season.
- If MPC-HC is closed before reaching 90%, just stops polling - no watched mark, no auto-advance.

This is all real code, but none of it has been confirmed against actual playback yet - it depends
on the Web Interface being enabled (see step 2 above) and `MpcStatus.cs`'s field-name assumptions
holding up. Test it by playing something through the launcher and watching the add-on's log for
`reportTimeline`/`markWatched` activity, and confirm episode auto-advance actually fires near the
end of a real episode.

## Future enhancements (Plex Pass)

Not built yet - see the plan doc's section 12 for design notes:

- **Auto-skip intro** - read Plex's intro marker (`GET /library/metadata/{ratingKey}?includeMarkers=1`)
  and start MPC-HC at the marker's end offset instead of 0:00.
