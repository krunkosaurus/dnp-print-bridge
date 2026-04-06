#!/usr/bin/env bash

set -euo pipefail

export DISPLAY="${DISPLAY:-:0}"
export XAUTHORITY="${XAUTHORITY:-/home/pi/.Xauthority}"

until [ -S "/tmp/.X11-unix/X0" ]; do
  sleep 2
done

until curl -fsS "http://127.0.0.1:3456/health" >/dev/null 2>&1; do
  sleep 2
done

exec chromium-browser \
  --incognito \
  --disable-pinch \
  --overscroll-history-navigation=0 \
  --noerrdialogs \
  --disable-infobars \
  --check-for-update-interval=604800 \
  --no-first-run \
  --app=http://127.0.0.1:3456 \
  --kiosk
