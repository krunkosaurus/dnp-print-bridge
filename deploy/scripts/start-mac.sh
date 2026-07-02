#!/usr/bin/env bash
#
# Launch the DNP Print Bridge on macOS against the locally attached DS-RX1.
#
# Defaults are pinned to the USB printer detected on this Mac and the loaded
# 6x4 ribbon. Any value can be overridden from the environment, e.g.:
#
#   HOST=127.0.0.1 ./deploy/scripts/start-mac.sh      # local-only
#   DEFAULT_MEDIA=5x7 ./deploy/scripts/start-mac.sh    # different media pack
#   AUTH_TOKEN=secret ./deploy/scripts/start-mac.sh    # require a bearer token
#
set -euo pipefail

# Run from the repo root regardless of where the script is invoked from.
cd "$(dirname "$0")/../.."

export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-3456}"
# CUPS queue name for the attached DS-RX1 (serial CB2D5B205632). The bridge
# prefix-matches this, so a re-added queue like *_4 still resolves.
export PRINTER_NAME="${PRINTER_NAME:-Dai_Nippon_Printing_DS_RX1_3}"
# Match the loaded ribbon so requests that omit a size don't fall back to the
# queue's 6x8 default PageSize.
export DEFAULT_MEDIA="${DEFAULT_MEDIA:-6x4}"

exec node server.js
