# Troubleshooting

## The add-on Settings page asks for a PIN

Enter the admin PIN previously saved in Media Launcher, not a Home Assistant or Plex password. It
is remembered in that browser profile. To stop requiring a PIN, authenticate once and choose
**Disable admin PIN** in Security. Clear the site's local storage to forget a cached PIN. If the PIN
is lost, stop the add-on, remove `adminPinHash` from `/data/settings.json`, and restart.

## Playback returns 401

The saved pairing keys do not match. Update both the beta add-on and beta Windows agent first. The
agent normally recovers by registering again with its configured add-on URL. For a clean recovery,
choose **Remove device** in the add-on Settings, then open the Windows player's tray Settings,
choose **Reset pairing**, and Save. Reset rotates the local identity because removed identities are
intentionally blocked from silently returning. Changing the player port still requires restarting
the Windows app.

## Pairing is pending after a timeout

Save Settings again to retry with the same persisted key. A lost first response does not create a
new key, and the pending device is not offered as a playback target until authentication is
confirmed. If the agent was deliberately removed, reset pairing locally before retrying.

## Playback says the path is outside the allowed roots

Add the mapped Windows UNC root to the player Settings dialog, one root per line. For example, an
add-on target `//nas/Movies` corresponds to player root `\\nas\Movies`. Do not enter a specific
movie filename. Local drive paths and URLs are intentionally rejected.

## The player or add-on is unreachable

- Confirm Windows Firewall permits inbound TCP on the configured player port from the HA host.
- Confirm the add-on exposes port 8088 and both devices are on the same trusted network.
- Confirm the Windows player's Home Assistant URL points directly to this add-on. Registration is
  directed to that URL; it does not use mDNS or scan other devices.
- Open `http://<media-pc>:7777/health`; it should return availability and pairing state without a
  secret.
- Inspect `%LocalAppData%\MediaLauncherPlayerAgent\player-agent.log` from the player Settings tab.

## The kiosk is blank or stale

Install/update Microsoft Edge WebView2 Runtime, verify the add-on URL uses `http://` or `https://`,
and choose Reload from the tray menu to clear WebView2's disk cache before refreshing.

## Plex linking or library discovery fails

Confirm the Plex URL is reachable from the Home Assistant host and includes the port when needed.
Relink the Plex account from Settings. If a token may be compromised, revoke it in Plex and link
again. Do not configure a public or untrusted server as the Plex URL.

## Playback monitoring verification

Only targets advertising status/position/duration capabilities are monitored. In
`1.8.0-beta.1`, that means MPC-HC; VLC, PotPlayer, and custom profiles are intentionally marked
**launch only** and will not update Plex progress or auto-play the next episode.

1. In MPC-HC, enable View → Options → Player → Web Interface on port 13579.
2. While an item plays, open `http://localhost:13579/variables.html` on the media PC and confirm it
   contains `file`, `state`, `position`, and `duration` fields.
3. Start an episode through Media Launcher and confirm Plex progress changes within roughly 10–20
   seconds.
4. Pass 90% and confirm playback continues rather than immediately skipping.
5. Let playback stop near the end and confirm the next episode starts once.
6. Start a different item early and confirm the prior item stops receiving progress updates.

Record the MPC-HC version and relevant player/add-on logs when reporting a mismatch.
