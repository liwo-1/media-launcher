#!/bin/sh
set -e

OPTIONS=/data/options.json

export PLEX_URL="$(jq -r '.plex_url' "$OPTIONS")"
export PLEX_TOKEN="$(jq -r '.plex_token' "$OPTIONS")"
export PLAYER_AGENT_URL="$(jq -r '.player_agent_url' "$OPTIONS")"
export PATH_MAP="$(jq -c '.path_map' "$OPTIONS")"
export PORT=8088

cd /app
exec node server.js
