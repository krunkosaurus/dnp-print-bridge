const stateRefs = {
  livePill: document.getElementById("live-pill"),
  liveLabel: document.getElementById("live-label"),
  statusText: document.getElementById("status-text"),
  statusDetail: document.getElementById("status-detail"),
  wifiName: document.getElementById("wifi-name"),
  wifiDetail: document.getElementById("wifi-detail"),
  tailscaleIp: document.getElementById("tailscale-ip"),
  tailscaleAuth: document.getElementById("tailscale-auth"),
  tailscaleAuthDetail: document.getElementById("tailscale-auth-detail"),
  tailscaleAuthUrl: document.getElementById("tailscale-auth-url"),
  tailscaleAuthQr: document.getElementById("tailscale-auth-qr"),
  previewImage: document.getElementById("preview-image"),
  previewReady: document.getElementById("preview-ready"),
  previewMeta: document.getElementById("preview-meta"),
  printedToday: document.getElementById("printed-today"),
  printerName: document.getElementById("printer-name"),
  printerStatus: document.getElementById("printer-status"),
  openJobs: document.getElementById("open-jobs"),
  queueDetail: document.getElementById("queue-detail"),
  localTime: document.getElementById("local-time"),
  updatedAt: document.getElementById("updated-at"),
};

let currentState = null;
let pollTimer = null;
let clockTimer = null;
let previewKey = "";

function formatClock(date) {
  return new Intl.DateTimeFormat([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function formatWifiDetail(wifi) {
  const ips = Array.isArray(wifi.ips) ? wifi.ips.filter(Boolean) : [];
  const sshHint = ips.length > 0 ? ` | ssh pi@${ips[0]}` : "";

  if (wifi.ssid) {
    return `Connected on ${wifi.interface || "wlan0"}${sshHint}`;
  }

  if (ips.length > 0) {
    return `${wifi.interface || "wlan0"} has ${ips.join("  ")}${sshHint}`;
  }

  if (wifi.wpaState === "UNAVAILABLE") {
    return "Wi-Fi status is unavailable on this host";
  }

  return `${wifi.interface || "wlan0"} is not associated`;
}

function formatTailscale(tailscale, legacyIps) {
  const ips = Array.isArray(tailscale?.ips) ? tailscale.ips : legacyIps;

  if (Array.isArray(ips) && ips.length > 0) {
    return ips.join("  ");
  }

  if (tailscale?.authRequired) {
    return "Login required";
  }

  if (tailscale?.backendState) {
    return tailscale.backendState;
  }

  return "Not connected";
}

function renderTailscaleAuth(tailscale) {
  const authUrl = tailscale?.authUrl || "";
  const authQr = tailscale?.authQr || "";
  const shouldShow = Boolean(tailscale?.authRequired && authUrl);

  stateRefs.tailscaleAuth.classList.toggle("hidden", !shouldShow);
  if (!shouldShow) {
    stateRefs.tailscaleAuthUrl.textContent = "";
    stateRefs.tailscaleAuthQr.textContent = "";
    return;
  }

  stateRefs.tailscaleAuthDetail.textContent =
    "Scan this QR code to reconnect the bridge to your tailnet.";
  stateRefs.tailscaleAuthUrl.textContent = authUrl;
  stateRefs.tailscaleAuthQr.textContent = authQr || authUrl;
}

function setConnectivity(online) {
  stateRefs.livePill.classList.toggle("offline", !online);
  stateRefs.liveLabel.textContent = online ? "ONLINE" : "OFFLINE";
}

function renderPreview(preview) {
  if (!preview) {
    previewKey = "";
    stateRefs.previewImage.classList.remove("visible");
    stateRefs.previewImage.removeAttribute("src");
    stateRefs.previewReady.classList.remove("hidden");
    stateRefs.previewMeta.textContent = "No active print job";
    return;
  }

  const secondsLeft = Math.max(1, Math.ceil((preview.remainingMs || 0) / 1000));
  stateRefs.previewMeta.textContent = preview.imageUrl
    ? `Showing ${preview.jobName} for ${secondsLeft}s`
    : `Received ${preview.jobName}. Preview unavailable for this file type.`;

  if (preview.imageUrl) {
    const nextPreviewKey = `${preview.jobId}:${preview.expiresAt}`;
    if (previewKey !== nextPreviewKey) {
      previewKey = nextPreviewKey;
      stateRefs.previewImage.src = preview.imageUrl;
    }
    stateRefs.previewImage.classList.add("visible");
    stateRefs.previewReady.classList.add("hidden");
    return;
  }

  previewKey = "";
  stateRefs.previewImage.classList.remove("visible");
  stateRefs.previewImage.removeAttribute("src");
  stateRefs.previewReady.classList.remove("hidden");
}

function renderState(state) {
  currentState = state;
  const preview = state.preview || null;
  const printer = state.printer || null;
  const queue = state.queue || {};
  const wifi = state.wifi || {};
  const tailscale = state.tailscale || {};

  setConnectivity(true);
  stateRefs.statusText.textContent = preview ? "PRINTING" : "READY";
  stateRefs.statusDetail.textContent = preview
    ? `Dispatching ${preview.jobName} to ${preview.printer || "the printer"}.`
    : "Listening for the next print request.";
  stateRefs.wifiName.textContent = wifi.ssid || "Not connected";
  stateRefs.wifiDetail.textContent = formatWifiDetail(wifi);
  stateRefs.tailscaleIp.textContent = formatTailscale(tailscale, state.tailscaleIps);
  stateRefs.printedToday.textContent = String(state.printedToday || 0);
  stateRefs.printerName.textContent = state.defaultPrinter || "No printer queue";
  stateRefs.printerStatus.textContent = printer
    ? printer.status
    : "Queue not detected";
  stateRefs.openJobs.textContent = String(queue.openJobs || 0);
  stateRefs.queueDetail.textContent =
    queue.openJobs > 0
      ? `${queue.queued || 0} queued, ${queue.openJobs} active in bridge`
      : "Queue is idle";
  stateRefs.updatedAt.textContent = state.updatedAt
    ? `Bridge updated ${new Date(state.updatedAt).toLocaleTimeString()}`
    : "Awaiting bridge state";

  renderPreview(preview);
  renderTailscaleAuth(tailscale);
}

function renderOffline(error) {
  setConnectivity(false);
  stateRefs.statusText.textContent = "OFFLINE";
  stateRefs.statusDetail.textContent = "Waiting for the local print bridge to respond.";
  stateRefs.wifiName.textContent = "Unavailable";
  stateRefs.wifiDetail.textContent = "Bridge offline";
  stateRefs.tailscaleIp.textContent = "Unavailable";
  stateRefs.printerName.textContent = "Bridge unavailable";
  stateRefs.printerStatus.textContent = error || "No response from /ui/state";
  stateRefs.openJobs.textContent = "0";
  stateRefs.queueDetail.textContent = "Diagnostics paused";
  stateRefs.updatedAt.textContent = "Reconnecting…";
  renderPreview(null);
  renderTailscaleAuth(null);
}

async function refreshState() {
  try {
    const response = await fetch("/ui/state", {
      cache: "no-store",
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    renderState(payload.state || {});
  } catch (error) {
    renderOffline(error.message);
  }
}

function updateClock() {
  const now = new Date();
  stateRefs.localTime.textContent = formatClock(now);
}

function start() {
  updateClock();
  refreshState();
  pollTimer = window.setInterval(refreshState, 2500);
  clockTimer = window.setInterval(updateClock, 1000);
}

window.addEventListener("online", () => {
  if (!currentState) {
    refreshState();
  } else {
    setConnectivity(true);
  }
});

window.addEventListener("offline", () => {
  renderOffline("Browser lost network connectivity");
});

window.addEventListener("beforeunload", () => {
  if (pollTimer) {
    window.clearInterval(pollTimer);
  }
  if (clockTimer) {
    window.clearInterval(clockTimer);
  }
});

start();
