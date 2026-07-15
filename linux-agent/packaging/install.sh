#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
binary="$script_dir/media-launcher-linux-agent"
if [ ! -f "$binary" ]; then
  binary="$script_dir/../media-launcher-linux-agent"
fi
if [ ! -f "$binary" ]; then
  echo "media-launcher-linux-agent was not found beside install.sh" >&2
  exit 1
fi

install_dir="$HOME/.local/lib/media-launcher-agent"
config_home=${XDG_CONFIG_HOME:-"$HOME/.config"}
unit_dir="$config_home/systemd/user"
config_dir="$config_home/media-launcher-agent"
config_file="$config_dir/config.json"
install -d -m 700 "$install_dir" "$unit_dir" "$config_dir"
install -m 700 "$binary" "$install_dir/media-launcher-linux-agent"
install -m 600 "$script_dir/media-launcher-agent.service" "$unit_dir/media-launcher-agent.service"

systemctl --user daemon-reload
if [ -f "$config_file" ]; then
  systemctl --user enable media-launcher-agent.service
  systemctl --user restart media-launcher-agent.service
  echo "Media Launcher Linux agent installed and restarted."
else
  echo "Agent installed. Configure it before starting:"
  echo "  $install_dir/media-launcher-linux-agent configure --home-assistant-url http://HA-HOST:8089 --allowed-root /mnt/media"
  echo "  systemctl --user enable --now media-launcher-agent.service"
fi
