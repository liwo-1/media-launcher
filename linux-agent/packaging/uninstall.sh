#!/bin/sh
set -eu

config_home=${XDG_CONFIG_HOME:-"$HOME/.config"}
systemctl --user disable --now media-launcher-agent.service 2>/dev/null || true
rm -f "$config_home/systemd/user/media-launcher-agent.service"
rm -rf "$HOME/.local/lib/media-launcher-agent"
systemctl --user daemon-reload
echo "Agent program removed. Private configuration remains in $config_home/media-launcher-agent."
