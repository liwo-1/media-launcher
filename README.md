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
- **`player-agent/`** - runs on the media PC. The only code that has to live there. Receives a file
  path over HTTP and spawns MPC-HC.

## Setup order

### 1. Prerequisites

- An existing Plex Media Server (NAS or separate box), already running and with its libraries
  scanned/matched. Just need a token and its reachable address.
- Node.js LTS on the media PC.
- MPC-HC installed on the media PC.
- SMB access from the media PC to the NAS export, with saved credentials so opening a UNC path never
  prompts for auth.

### 2. player-agent (media PC)

```powershell
cd player-agent
npm install
copy .env.example .env
# edit .env if MPC-HC isn't at one of the default install paths
npm start
```

Test it directly before wiring up anything else:

```powershell
$body = @{ path = "\\nas\Movies\<some real file>.mkv" } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:7777/play" -Method Post -Body $body -ContentType "application/json"
```

MPC-HC should open fullscreen playing that file. Test again with MPC-HC already open to confirm it
reuses the existing window rather than stacking a new one (default MPC-HC behavior - only an issue
if "Allow multiple instances" is enabled in its options).

**Also enable MPC-HC's Web Interface** (View → Options → Player → Web Interface → check "Listen on
port", default 13579) - needed for playback monitoring (progress reporting back to Plex + auto-play
next episode, see below). Confirm it's working by opening
`http://localhost:13579/variables.html` directly in a browser while something's playing - it should
show simple `<p id="...">` tags for `file`/`state`/`position`/`duration`. player-agent's
`mpc-status.js` assumes this shape but hasn't been verified against a real install yet - if the
real output looks different, adjust the field list there.

Once confirmed, register it to run automatically at logon:

```powershell
cd scripts
.\install-task.ps1
```

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
   - **Library path mapping** - one row per library:
     - *from*: the path Plex itself reports for that library - check Plex web UI → Settings →
       Libraries → edit a library → folder path (or the `file` field returned by
       `GET /library/metadata/{ratingKey}`).
     - *to*: the same folder as a Windows UNC path reachable from the media PC (the actual NAS
       host/share name) - see the comment in `addon/app/src/pathmap.js` for the forward-slash
       convention (forward slashes on both sides, even for the Windows target).
   - **Plex Account** - click "Link with Plex", then enter the 4-character code shown at
     [plex.tv/link](https://plex.tv/link) on any device. The add-on polls and stores the token
     itself (in its persistent `/data` storage) - no token to copy-paste.
   - Click **Save**.

Test the full chain with a real item before building out the browsing UI further:

```powershell
Invoke-RestMethod -Uri "http://<ha-host-ip>:8088/api/play/<a-real-plex-ratingKey>" -Method Post
```

(Copy a `ratingKey` from Plex Web's URL bar when viewing an item.)

### 4. Kiosk browser (media PC)

Once the add-on is confirmed working:

```powershell
cd player-agent\scripts
.\install-kiosk-task.ps1 -Url "http://<ha-host-ip>:8088"
```

Reboot the media PC and confirm Edge comes up fullscreen on the library grid with no manual steps.

### 5. Phone

From a phone on the same LAN, browse to `http://<ha-host-ip>:8088`. Play should trigger playback on
the TV, not the phone.

## Local dev (without deploying to HA/the media PC)

Both pieces can run locally for iterating on code:

```powershell
# player-agent
cd player-agent && npm install && copy .env.example .env && npm start

# addon backend + frontend
cd addon\app && npm install && npm start
```

The addon backend has no options file to create - open `http://localhost:8088` and use the
Settings page, exactly like the real add-on (settings persist to `addon/app/local-data/`, gitignored).
For quick one-off overrides you can also set `PLEX_URL` / `PLEX_TOKEN` / `PLAYER_AGENT_URL` /
`PATH_MAP` / `PORT` as env vars before `npm start` - they take priority over whatever's saved.

Note: `PATH_MAP` (whether saved via the Settings page or set as an env var) is a JSON array - keep
both `from` and `to` as forward-slash paths (e.g. `"to": "//nas/Movies"`), never literal
backslashes. `pathmap.js` converts to backslashes as the final step.

## Playback monitoring (built, needs real-world verification)

After a successful Play, `src/playback-monitor.js` polls the media PC's player-agent every 10s
(which itself reads MPC-HC's Web Interface via `mpc-status.js`) and:

- Reports position/state back to Plex (`/:/timeline`) - makes progress from playback through this
  launcher show up in Plex's own "Continue Watching"/on-deck data, not just plays through Plex's
  own apps.
- Marks the item watched (`/:/scrobble`) once past 90% - the same threshold Plex/most clients use.
- If it was a TV episode, automatically starts the next episode in the season.
- If MPC-HC is closed before reaching 90%, just stops polling - no watched mark, no auto-advance.

This is all real code, but **untested against actual MPC-HC playback** - it depends on the Web
Interface being enabled (see step 2 above) and `mpc-status.js`'s field-name assumptions holding up.
Test it by playing something through the launcher and watching the add-on's log for
`reportTimeline`/`markWatched` activity, and confirm episode auto-advance actually fires near the
end of a real episode.

## Future enhancements (Plex Pass)

Not built yet - see the plan doc's section 12 for design notes:

- **Auto-skip intro** - read Plex's intro marker (`GET /library/metadata/{ratingKey}?includeMarkers=1`)
  and start MPC-HC at the marker's end offset instead of 0:00.
