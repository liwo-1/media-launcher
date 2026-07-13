#!/bin/sh
set -e

export PORT=8088

cd /app
exec node server.js
