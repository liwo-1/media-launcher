# Media Launcher Linux agent

The Linux agent is a self-contained .NET 8 user-session service. It never scans the LAN: it
registers only with the Home Assistant app URL you configure, receives one private pairing key,
and then accepts authenticated playback requests on port 7777.

## Install a release archive

Extract the archive for `linux-x64` or `linux-arm64`, then run:

```sh
./install.sh
~/.local/lib/media-launcher-agent/media-launcher-linux-agent configure \
  --home-assistant-url http://HOME-ASSISTANT:8089 \
  --allowed-root /mnt/media
systemctl --user enable --now media-launcher-agent.service
```

Repeat `--allowed-root` for each mounted media root. The root must be the Linux-side destination
used by that device's path mappings in the Home Assistant app. Pairing is automatic and does not
use the optional admin PIN. The installer and user service honor the systemd/XDG user configuration
directory (normally `~/.config`), while transient mpv and .NET files stay in the private user runtime
directory.

Useful local commands:

```sh
~/.local/lib/media-launcher-agent/media-launcher-linux-agent diagnose
~/.local/lib/media-launcher-agent/media-launcher-linux-agent --version
~/.local/lib/media-launcher-agent/media-launcher-linux-agent reset-pairing --yes
journalctl --user -u media-launcher-agent -f
```

Remove a device in Home Assistant before using `reset-pairing`; the command rotates the local
installation identity so the deliberately revoked identity cannot silently return.

## Player discovery and controls

- Native **mpv** uses a private, user-only Unix socket and supports status, pause/resume, absolute
  seek, stop, resume position, and fullscreen.
- **VLC** and configured generic MPRIS players use `playerctl` when installed. Without `playerctl`,
  VLC remains available as launch-only and reports that limitation in diagnostics.
- Known `.desktop` entries, Flatpak applications, Snap launchers, and safe custom profiles are
  discovered without invoking a shell. Sandboxed mpv packages are launch-only unless they expose a
  supported control interface. Flatpak and Snap discovery is automated, but launch behavior still
  depends on the distribution's sandbox tooling and has not passed the real-device acceptance gate.
- Custom profiles are edited in the private config file. Arguments are individual JSON tokens and
  may use `{media_path}`, `{title}`, and `{start_seconds}`. Shells and script hosts are rejected.

Run `diagnose` after editing configuration. It returns a non-zero status when configuration is
incomplete or no player is available, and never prints pairing secrets.

## Security boundary

Only existing files with an allowed video extension and a canonical path beneath an allowed root
can launch. Symlink components are resolved before the root check. The systemd unit runs as the
desktop user with a restrictive umask, no privilege escalation, and a read-only home view except
for standard XDG config/cache/data/state locations plus common Flatpak and Snap user-state roots.
Those writable locations are needed by child media players and do not imply that every sandboxed
package has been accepted. Do not expose port 7777 beyond the trusted home LAN.
