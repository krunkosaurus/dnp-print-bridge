const stateRefs = {
  livePill: document.getElementById("live-pill"),
  liveLabel: document.getElementById("live-label"),
  statusText: document.getElementById("status-text"),
  statusDetail: document.getElementById("status-detail"),
  wifiName: document.getElementById("wifi-name"),
  wifiDetail: document.getElementById("wifi-detail"),
  tailscaleIp: document.getElementById("tailscale-ip"),
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

function formatIpList(ips) {
  if (!Array.isArray(ips) || ips.length === 0) {
    return "Not connected";
  }

  return ips.join("  ");
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

  setConnectivity(true);
  stateRefs.statusText.textContent = preview ? "PRINTING" : "READY";
  stateRefs.statusDetail.textContent = preview
    ? `Dispatching ${preview.jobName} to ${preview.printer || "the printer"}.`
    : "Listening for the next print request.";
  stateRefs.wifiName.textContent = wifi.ssid || "Not connected";
  stateRefs.wifiDetail.textContent = wifi.ssid
    ? `Connected on ${wifi.interface || "wlan0"}`
    : wifi.wpaState === "UNAVAILABLE"
      ? "Wi-Fi status is unavailable on this host"
      : `${wifi.interface || "wlan0"} is not associated`;
  stateRefs.tailscaleIp.textContent = formatIpList(state.tailscaleIps);
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
