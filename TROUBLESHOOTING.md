# Troubleshooting

## The add-on Settings page asks for a PIN

Enter the admin PIN previously saved in Media Launcher, not a Home Assistant or Plex password. It
is remembered only until that page is reloaded or closed; the raw PIN is not written to browser
storage. To stop requiring a PIN, authenticate once and choose **Disable admin PIN** in Security. If
the PIN is lost, stop the add-on, remove `adminPinHash` from `/data/settings.json`, and restart.
If Settings reports that storage is unavailable, restore a valid JSON backup or repair that file;
the add-on deliberately keeps protected routes locked when an existing settings file is corrupt.

## Playback returns 401

The saved pairing keys do not match. Update both the beta add-on and the matching Windows/Linux
agent first. The
agent normally recovers by registering again with its configured add-on URL. For a clean recovery,
choose **Remove device** in the add-on Settings, then choose **Reset pairing** in the Windows tray
Settings or run the installed Linux agent with `reset-pairing --yes` locally. Reset rotates the local
identity because removed identities are
intentionally blocked from silently returning. Changing the player port still requires restarting
the Windows app.

## Pairing is pending after a timeout

Leave the agent running: it retries directed registration with the same persisted enrollment key.
A lost first response does not create a new key, and the pending device is not offered as a
playback target until authentication is confirmed. If the agent was deliberately removed, reset
pairing locally before retrying.

## Playback says the path is outside the allowed roots

On Windows, add the mapped UNC root to the player Settings dialog, one root per line. For example,
an add-on target `//nas/Movies` corresponds to player root `\\nas\Movies`; local drive paths and
URLs are intentionally rejected. On Linux, repeat `--allowed-root /mount/path` during configuration
for each absolute mounted destination. Symlinks that escape a Linux root are intentionally rejected.
Do not configure a specific movie filename as a root.

## The player or add-on is unreachable

- Confirm the playback-device firewall permits inbound TCP on the configured player port from the
  HA host.
- Confirm the stable/beta add-on exposes port 8088/8089 and both devices are on the same trusted
  network.
- Confirm the agent's Home Assistant URL points directly to this add-on. Registration is
  directed to that URL; it does not use mDNS or scan other devices.
- Open `http://<media-pc>:7777/health`; it should return availability and pairing state without a
  secret.
- On Windows, inspect `%LocalAppData%\MediaLauncherPlayerAgent\player-agent.log` from Settings.
- On Linux, run `systemctl --user status media-launcher-agent` and
  `journalctl --user -u media-launcher-agent -f`, then run the installed agent's `diagnose` command.

## The kiosk is blank or stale

Install/update Microsoft Edge WebView2 Runtime, verify the add-on URL uses `http://` or `https://`,
and choose Reload from the tray menu to clear WebView2's disk cache before refreshing.

## Plex linking or library discovery fails

Confirm the Plex URL is reachable from the Home Assistant host and includes the port when needed.
Relink the Plex account from Settings. If a token may be compromised, revoke it in Plex and link
again. Upgrading from an older beta with an unscoped saved token also requires one relink; this is a
fail-closed migration so the token cannot follow a changed server address. The old unscoped local
token is discarded while the Plex client identity is retained; revoke it in Plex as well if it may
have been exposed. Do not configure a public or untrusted server as the Plex URL.

## Jellyfin sign-in, browsing, or discovery fails

Use the exact Jellyfin address reachable from the Home Assistant host, including a reverse-proxy
base path such as `/jellyfin` when applicable. Media Launcher rejects redirects before sending a
password, so an address that merely redirects to the final Jellyfin URL will not work. Jellyfin
10.10.7 or newer is required.

Library browsing and playback use the signed-in user's normal permissions. Automatic library-path
discovery and scan actions require that user to be a Jellyfin administrator; discovery reads the
server's virtual-folder paths and a Jellyfin scan refreshes the whole server library. If direct
playback says no file source is available, confirm the item exposes a filesystem-backed `File`
media source and add a mapping from the server/container path to the path visible on the player.

## Playback monitoring verification

Only targets advertising status/position/duration capabilities are monitored. In
`2.0.0-beta.1`, that includes MPC-HC, Windows VLC, native Linux mpv, and Linux players with a
working MPRIS/`playerctl` adapter. PotPlayer and any profile without a reliable status surface are
marked **launch only** and do not update Plex/Jellyfin progress or auto-play the next episode.

1. In MPC-HC, enable View → Options → Player → Web Interface on port 13579.
2. While an item plays, open `http://localhost:13579/variables.html` on the media PC and confirm it
   contains `file`, `state`, `position`, and `duration` fields.
3. Start an episode through Media Launcher and confirm Plex or Jellyfin progress changes within
   roughly 10–20 seconds.
4. Pass 90% and confirm playback continues rather than immediately skipping.
5. Let playback stop near the end and confirm the next episode starts once.
6. Start a different item early and confirm the prior item stops receiving progress updates.

Record the MPC-HC version and relevant player/add-on logs when reporting a mismatch.

## Pause, seek, or stop is not shown

Controls are advertised per player, not guessed from its process name. Update the beta add-on and
agent together, then check the player card in Connections or run Linux `diagnose`. Windows VLC and
native Linux mpv support pause/resume, seek, and stop. MPC-HC currently provides monitored status
and owned-process stop; PotPlayer is launch-and-stop only. Linux VLC/MPRIS controls require
`playerctl`. A launch-only target continuing to play after its small launcher process exits usually
means that player handed the file to an existing instance; choose a profile that exposes a reliable
control interface if remote transport controls are required.

## The Linux user service will not start

Run the installed executable with `diagnose` and confirm the Home Assistant URL, at least one
absolute allowed root, and at least one available player. The service belongs to the graphical
desktop user; do not install or start it with `sudo`. If no user bus is available, log into the
desktop session before running `systemctl --user enable --now media-launcher-agent.service`.
For VLC/MPRIS status install `playerctl`; native mpv control does not require it.
