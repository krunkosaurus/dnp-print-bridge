#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PI_HOME="/home/pi"
PROFILE_PATH="${PI_HOME}/.bash_profile"
PROFILE_BACKUP_PATH="${PI_HOME}/.bash_profile.dnp-print-bridge.bak"
BRIDGE_SERVICE_PATH="/etc/systemd/system/dnp-print-bridge.service"
KIOSK_SERVICE_PATH="/etc/systemd/system/dnp-print-bridge-kiosk.service"
QUEUE_NAME="${QUEUE_NAME:-DNP_DSRX1}"
PRINTER_MODEL="${PRINTER_MODEL:-gutenprint.5.3://dnp-dsrx1/expert}"
PRINT_IMAGE_TYPE="${PRINT_IMAGE_TYPE:-Photo}"
PRINT_COLOR_CORRECTION="${PRINT_COLOR_CORRECTION:-Accurate}"
PRINT_COLOR_PRECISION="${PRINT_COLOR_PRECISION:-Best}"
PRINT_CYAN_BALANCE="${PRINT_CYAN_BALANCE:-}"
PRINT_MAGENTA_BALANCE="${PRINT_MAGENTA_BALANCE:-}"
PRINT_YELLOW_BALANCE="${PRINT_YELLOW_BALANCE:-}"

require_root() {
  if [ "${EUID}" -ne 0 ]; then
    echo "Run this script with sudo." >&2
    exit 1
  fi
}

disable_legacy_kiosk() {
  if [ -f "${PROFILE_PATH}" ]; then
    if grep -q -- '--app=http://localhost:80 --kiosk &' "${PROFILE_PATH}"; then
      cp "${PROFILE_PATH}" "${PROFILE_BACKUP_PATH}"
      sed -i 's|^DISPLAY=:0 chromium-browser .*--app=http://localhost:80 --kiosk &$|# Disabled by dnp-print-bridge install|' "${PROFILE_PATH}"
    fi
  fi

  systemctl disable --now nginx >/dev/null 2>&1 || true
  systemctl disable --now pm2-pi.service >/dev/null 2>&1 || true

  if [ -x /usr/bin/pm2 ]; then
    timeout 10 sudo -u pi /usr/bin/pm2 delete all >/dev/null 2>&1 || true
    timeout 10 sudo -u pi /usr/bin/pm2 kill >/dev/null 2>&1 || true
  fi
  rm -f "${PI_HOME}/.pm2/dump.pm2"
  pkill -u pi -f 'chromium-browser.*--app=http://localhost:80' >/dev/null 2>&1 || true
}

configure_printer_queue() {
  if lpstat -p "${QUEUE_NAME}" >/dev/null 2>&1; then
    lpadmin -d "${QUEUE_NAME}" >/dev/null 2>&1 || true
    return
  fi

  local printer_uri
  printer_uri="$(
    /usr/sbin/lpinfo -v \
      | awk '
        /gutenprint53\+usb:\/\/dnp-dsrx1/ { print $2; found=1; exit }
        /usb:\/\/(Dai%20Nippon%20Printing|Citizen|DNP)/ && !fallback { fallback=$2 }
        END { if (!found && fallback) print fallback }
      '
  )"

  if [ -z "${printer_uri}" ]; then
    echo "Unable to detect a DNP USB printer URI with lpinfo -v." >&2
    exit 1
  fi

  /usr/sbin/lpadmin -x "${QUEUE_NAME}" >/dev/null 2>&1 || true
  /usr/sbin/lpadmin \
    -p "${QUEUE_NAME}" \
    -E \
    -v "${printer_uri}" \
    -m "${PRINTER_MODEL}"
  lpadmin -d "${QUEUE_NAME}"
  lpadmin -p "${QUEUE_NAME}" -o "StpImageType=${PRINT_IMAGE_TYPE}"
  lpadmin -p "${QUEUE_NAME}" -o "StpColorCorrection=${PRINT_COLOR_CORRECTION}"
  lpadmin -p "${QUEUE_NAME}" -o "StpColorPrecision=${PRINT_COLOR_PRECISION}"

  if [ -n "${PRINT_CYAN_BALANCE}" ]; then
    lpadmin -p "${QUEUE_NAME}" -o "StpCyanBalance=${PRINT_CYAN_BALANCE}"
  fi

  if [ -n "${PRINT_MAGENTA_BALANCE}" ]; then
    lpadmin -p "${QUEUE_NAME}" -o "StpMagentaBalance=${PRINT_MAGENTA_BALANCE}"
  fi

  if [ -n "${PRINT_YELLOW_BALANCE}" ]; then
    lpadmin -p "${QUEUE_NAME}" -o "StpYellowBalance=${PRINT_YELLOW_BALANCE}"
  fi
}

install_services() {
  install -m 0644 "${REPO_ROOT}/deploy/systemd/dnp-print-bridge.service" "${BRIDGE_SERVICE_PATH}"
  install -m 0644 "${REPO_ROOT}/deploy/systemd/dnp-print-bridge-kiosk.service" "${KIOSK_SERVICE_PATH}"
  systemctl daemon-reload
  systemctl enable --now dnp-print-bridge.service
  systemctl enable --now dnp-print-bridge-kiosk.service
}

configure_tailscale_operator() {
  if ! command -v tailscale >/dev/null 2>&1; then
    echo "Tailscale CLI not found; skipping kiosk auth QR operator setup." >&2
    return
  fi

  systemctl enable --now tailscaled.service >/dev/null 2>&1 || true

  if tailscale set --operator=pi >/dev/null 2>&1; then
    echo "Configured Tailscale operator user pi for kiosk auth QR recovery."
    return
  fi

  echo "Unable to configure Tailscale operator user pi; QR recovery may need sudo/root permission." >&2
}

require_root
disable_legacy_kiosk
configure_printer_queue
configure_tailscale_operator
install_services

echo "Configured ${QUEUE_NAME}, photo defaults, dnp-print-bridge.service, and dnp-print-bridge-kiosk.service."
