# Architecture

Media Launcher has two deployable components and uses Plex only for metadata and watch state.
MPC-HC reads the media file directly from its Windows-accessible UNC path.

```mermaid
flowchart LR
    U[Phone / browser] -->|HTTP :8088| A[Home Assistant add-on]
    W[WebView2 kiosk] -->|HTTP :8088| A
    H[Home Assistant Ingress] --> A
    A -->|Plex API + token| P[Plex Media Server]
    A -->|One-time /pair while agent is empty| G
    A -->|Bearer-authenticated /play + /status| G[Windows player-agent :7777]
    G -->|Process arguments| M[MPC-HC]
    M -->|SMB / UNC file access| N[NAS]
    G -->|localhost :13579| M
```

## Home Assistant add-on

The Node/Express process serves the static frontend and API from one port. `plex.js` is the Plex
adapter, `pathmap.js` translates Plex paths into approved Windows paths, and
`playback-monitor.js` owns the single active playback session. Persistent data lives in `/data` in
Home Assistant and `addon/app/local-data` during local development.

Settings and Plex linking require the admin PIN once configured. Normal library browsing and
household controls remain open by design. The Plex token is never returned to the browser.

## Windows player-agent

The .NET 8 WinForms application hosts both WebView2 and a small Kestrel server. The server validates
the bearer secret and media path before `MpcLauncher` starts MPC-HC. MPC status is read only from
MPC-HC's localhost Web Interface. Configuration and logs live under the current user's LocalAppData.

On first setup, the add-on generates and persists a random key, then posts it to the agent's
one-time `/pair` endpoint. The agent accepts that endpoint only while it has no key. Once paired,
remote re-pairing is rejected; clearing the key requires the local Windows Settings dialog.

## Playback sequence

1. The browser posts a Plex rating key to the add-on.
2. The add-on obtains the media file from Plex metadata and applies a boundary-safe path mapping.
3. The add-on sends the UNC path and bearer secret to the player.
4. The player validates the secret, UNC root, and extension, then starts MPC-HC.
5. One monitor session polls status, reports progress, marks watched near the threshold, and only
   advances after a near-end transition to stopped.
