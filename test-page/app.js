const STORAGE_KEY = "dnp-print-bridge-test-page";
const POLL_INTERVAL_MS = 2000;
const INSPECT_REFRESH_MS = 15000;
const SUBMIT_COOLDOWN_MS = 5000;

const refs = {
  harnessStatus: document.getElementById("harness-status"),
  bridgeForm: document.getElementById("bridge-form"),
  targetInput: document.getElementById("target-input"),
  authTokenInput: document.getElementById("auth-token-input"),
  sizeInput: document.getElementById("size-input"),
  copiesInput: document.getElementById("copies-input"),
  printerInput: document.getElementById("printer-input"),
  jobNameInput: document.getElementById("job-name-input"),
  dropzone: document.getElementById("dropzone"),
  fileInput: document.getElementById("file-input"),
  dropPreview: document.getElementById("drop-preview"),
  previewImage: document.getElementById("preview-image"),
  previewEmpty: document.getElementById("preview-empty"),
  previewOverlay: document.getElementById("preview-overlay"),
  fileName: document.getElementById("file-name"),
  fileDetail: document.getElementById("file-detail"),
  printButton: document.getElementById("print-button"),
  removeFileButton: document.getElementById("remove-file-button"),
  clearJobButton: document.getElementById("clear-job-button"),
  summaryTarget: document.getElementById("summary-target"),
  summaryUpdated: document.getElementById("summary-updated"),
  summaryStatus: document.getElementById("summary-status"),
  summaryPrinter: document.getElementById("summary-printer"),
  summaryJobs: document.getElementById("summary-jobs"),
  summaryTailscale: document.getElementById("summary-tailscale"),
  jobId: document.getElementById("job-id"),
  jobCreated: document.getElementById("job-created"),
  jobStatus: document.getElementById("job-status"),
  jobDetail: document.getElementById("job-detail"),
  jobCups: document.getElementById("job-cups"),
  jobError: document.getElementById("job-error"),
  eventLog: document.getElementById("event-log"),
  inspectJson: document.getElementById("inspect-json"),
  jobJson: document.getElementById("job-json"),
  authTokenMessage: document.getElementById("auth-token-message"),
};

const state = {
  selectedFile: null,
  selectedFileDataUrl: "",
  submissionMarkerVisible: false,
  submitCooldownUntil: 0,
  submitCooldownTimer: null,
  activeJobId: "",
  inspectTimer: null,
  jobTimer: null,
  lastInspect: null,
};

function loadSettings() {
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveSettings() {
  const payload = {
    target: refs.targetInput.value.trim(),
    authToken: refs.authTokenInput.value,
    size: refs.sizeInput.value.trim(),
    copies: refs.copiesInput.value,
    printer: refs.printerInput.value.trim(),
    jobName: refs.jobNameInput.value.trim(),
  };

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function applySettings() {
  const saved = loadSettings();

  refs.targetInput.value = saved.target || "";
  refs.authTokenInput.value = saved.authToken || "";
  refs.sizeInput.value = saved.size || "6x4";
  refs.copiesInput.value = saved.copies || "1";
  refs.printerInput.value = saved.printer || "";
  refs.jobNameInput.value = saved.jobName || "tailscale-test-print";
}

function setHarnessStatus(message, tone = "") {
  refs.harnessStatus.textContent = message;
  refs.harnessStatus.classList.remove("success", "error");
  if (tone) {
    refs.harnessStatus.classList.add(tone);
  }
}

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

function appendLog(title, detail, tone = "") {
  const entry = document.createElement("article");
  entry.className = `log-entry${tone ? ` ${tone}` : ""}`;

  const strong = document.createElement("strong");
  strong.textContent = `[${new Date().toLocaleTimeString()}] ${title}`;

  const span = document.createElement("span");
  span.textContent = detail;

  entry.append(strong, span);
  refs.eventLog.prepend(entry);
}

async function postJson(pathname, body) {
  const response = await fetch(pathname, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error || `Request failed with HTTP ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

function setAuthMessage(text, tone = "") {
  if (!text) {
    refs.authTokenMessage.textContent = "";
    refs.authTokenMessage.classList.remove("show", "warning", "error");
    return;
  }

  refs.authTokenMessage.textContent = text;
  refs.authTokenMessage.classList.add("show");
  refs.authTokenMessage.classList.remove("warning", "error");
  if (tone) {
    refs.authTokenMessage.classList.add(tone);
  }
}

function isAuthError(error) {
  return error && (error.status === 401 || error.status === 403);
}

function evaluateAuthState({ authToken, probes }) {
  const authRequired = probes?.health?.payload?.authEnabled === true;
  const probeList = [probes?.health, probes?.uiState, probes?.stats, probes?.printers];
  const rejectedProbe = probeList.find(
    (probe) => probe && probe.ok === false && (probe.status === 401 || probe.status === 403)
  );

  if (rejectedProbe) {
    if (!authToken) {
      setAuthMessage(
        `This bridge requires an AUTH_TOKEN (got HTTP ${rejectedProbe.status} on ${rejectedProbe.pathname || "a request"}). Paste the token above and refresh.`,
        "error"
      );
      setHarnessStatus("Auth token required", "error");
    } else {
      setAuthMessage(
        `Bridge rejected this token (HTTP ${rejectedProbe.status}). Confirm the AUTH_TOKEN set on the bridge.`,
        "error"
      );
      setHarnessStatus("Auth token rejected by bridge", "error");
    }
    return;
  }

  if (authRequired && !authToken) {
    setAuthMessage(
      "This bridge requires an AUTH_TOKEN. Paste it above before submitting a print.",
      "warning"
    );
    return;
  }

  setAuthMessage("");
}

function getBridgeSettings() {
  return {
    target: refs.targetInput.value.trim(),
    authToken: refs.authTokenInput.value,
    size: refs.sizeInput.value.trim(),
    copies: Number(refs.copiesInput.value || 1),
    printer: refs.printerInput.value.trim(),
    jobName: refs.jobNameInput.value.trim(),
  };
}

function clearSubmitCooldownTimer() {
  if (state.submitCooldownTimer) {
    window.clearTimeout(state.submitCooldownTimer);
    state.submitCooldownTimer = null;
  }
}

function isSubmitCoolingDown() {
  return Date.now() < state.submitCooldownUntil;
}

function syncPrintButtonState() {
  const hasFile = Boolean(state.selectedFile && state.selectedFileDataUrl);
  const coolingDown = isSubmitCoolingDown();

  refs.printButton.disabled = !hasFile || coolingDown;
  refs.printButton.textContent = coolingDown
    ? "Submitted"
    : "Submit print job";
}

function startSubmitCooldown() {
  state.submitCooldownUntil = Date.now() + SUBMIT_COOLDOWN_MS;
  clearSubmitCooldownTimer();
  syncPrintButtonState();

  state.submitCooldownTimer = window.setTimeout(() => {
    state.submitCooldownUntil = 0;
    state.submitCooldownTimer = null;
    syncPrintButtonState();
  }, SUBMIT_COOLDOWN_MS);
}

function updateFileUi() {
  const hasFile = Boolean(state.selectedFile && state.selectedFileDataUrl);
  refs.removeFileButton.disabled = !hasFile;
  refs.dropPreview.classList.toggle(
    "submitted",
    hasFile && state.submissionMarkerVisible
  );
  syncPrintButtonState();

  if (!hasFile) {
    refs.previewImage.removeAttribute("src");
    refs.dropPreview.classList.remove("has-image");
    refs.fileName.textContent = "No file selected";
    refs.fileDetail.textContent = "The dropped image will be sent to the remote bridge as a data URL.";
    return;
  }

  refs.previewImage.src = state.selectedFileDataUrl;
  refs.dropPreview.classList.add("has-image");
  refs.fileName.textContent = state.selectedFile.name;
  refs.fileDetail.textContent = `${Math.round(state.selectedFile.size / 1024)} KB • ${state.selectedFile.type || "unknown type"}`;
}

function clearSelectedFile() {
  state.selectedFile = null;
  state.selectedFileDataUrl = "";
  state.submissionMarkerVisible = false;
  state.submitCooldownUntil = 0;
  clearSubmitCooldownTimer();
  refs.fileInput.value = "";
  updateFileUi();
}

function clearJobPolling() {
  if (state.jobTimer) {
    window.clearTimeout(state.jobTimer);
    state.jobTimer = null;
  }
}

function clearInspectPolling() {
  if (state.inspectTimer) {
    window.clearTimeout(state.inspectTimer);
    state.inspectTimer = null;
  }
}

function clearJobView() {
  clearJobPolling();
  state.activeJobId = "";
  refs.jobId.textContent = "Waiting";
  refs.jobCreated.textContent = "No job accepted yet";
  refs.jobStatus.textContent = "Idle";
  refs.jobDetail.textContent = "Submit a job to start polling";
  refs.jobCups.textContent = "-";
  refs.jobError.textContent = "No error reported";
  refs.jobJson.textContent = "No job activity yet.";
}

function updateInspectSummary(payload) {
  state.lastInspect = payload;
  refs.inspectJson.textContent = formatJson(payload);
  refs.summaryTarget.textContent = payload.target || "Unknown";
  refs.summaryUpdated.textContent = `Snapshot ${new Date(payload.inspectedAt).toLocaleString()}`;

  const uiState = payload.probes?.uiState;
  const health = payload.probes?.health;
  const stats = payload.probes?.stats;
  const printers = payload.probes?.printers;

  evaluateAuthState({
    authToken: refs.authTokenInput.value.trim(),
    probes: { health, uiState, stats, printers },
  });

  const remoteState = uiState?.payload?.state || null;
  refs.summaryStatus.textContent = remoteState?.status || (health?.ok ? "Connected" : "Unavailable");
  refs.summaryPrinter.textContent =
    remoteState?.defaultPrinter ||
    health?.payload?.defaultPrinter ||
    uiState?.error ||
    health?.error ||
    "Printer data unavailable";

  refs.summaryJobs.textContent = String(
    remoteState?.queue?.openJobs ??
      stats?.payload?.stats?.openJobs ??
      0
  );

  const tailscaleIps = remoteState?.tailscaleIps;
  refs.summaryTailscale.textContent =
    Array.isArray(tailscaleIps) && tailscaleIps.length > 0
      ? tailscaleIps.join("  ")
      : "No Tailscale IP reported";
}

function scheduleInspectRefresh() {
  clearInspectPolling();
  if (!refs.targetInput.value.trim()) {
    return;
  }

  state.inspectTimer = window.setTimeout(() => {
    inspectBridge(true).catch((error) => {
      appendLog("Remote snapshot failed", error.message, "error");
    });
  }, INSPECT_REFRESH_MS);
}

async function inspectBridge(background = false) {
  const settings = getBridgeSettings();
  saveSettings();

  if (!settings.target) {
    throw new Error("Enter a Tailscale IP or bridge URL first");
  }

  if (!background) {
    setHarnessStatus("Refreshing bridge data");
  }

  const payload = await postJson("/api/inspect", {
    target: settings.target,
    authToken: settings.authToken,
  });

  updateInspectSummary(payload);
  setHarnessStatus(`Connected to ${payload.target}`, "success");

  if (!background) {
    appendLog("Bridge snapshot updated", `Remote target ${payload.target}`, "success");
  }

  scheduleInspectRefresh();
  return payload;
}

function updateJobSummary(job) {
  refs.jobId.textContent = job.id || "Unknown";
  refs.jobCreated.textContent = job.createdAt
    ? `Created ${new Date(job.createdAt).toLocaleString()}`
    : "Creation time unavailable";
  refs.jobStatus.textContent = job.status || "Unknown";
  refs.jobDetail.textContent = `Jobs ahead: ${job.jobsAhead ?? 0} • Printer: ${job.printer || "unknown"}`;
  refs.jobCups.textContent = job.cupsRequestId || "-";
  refs.jobError.textContent = job.error || "No error reported";
}

async function pollJob() {
  const settings = getBridgeSettings();
  if (!state.activeJobId) {
    return;
  }

  try {
    const payload = await postJson("/api/job", {
      target: settings.target,
      authToken: settings.authToken,
      jobId: state.activeJobId,
    });

    refs.jobJson.textContent = formatJson(payload);
    const job = payload.remote?.job || {};
    updateJobSummary(job);

    if (job.status === "completed") {
      appendLog("Job completed", `Bridge job ${job.id} completed successfully`, "success");
      setHarnessStatus("Last job completed", "success");
      clearJobPolling();
      inspectBridge(true).catch(() => {});
      return;
    }

    if (job.status === "failed") {
      appendLog("Job failed", job.error || `Bridge job ${job.id} failed`, "error");
      setHarnessStatus("Last job failed", "error");
      clearJobPolling();
      inspectBridge(true).catch(() => {});
      return;
    }

    state.jobTimer = window.setTimeout(pollJob, POLL_INTERVAL_MS);
  } catch (error) {
    appendLog("Job poll failed", error.message, "error");
    setHarnessStatus("Remote polling failed", "error");
    clearJobPolling();
  }
}

async function handlePrint() {
  const settings = getBridgeSettings();
  saveSettings();

  if (!settings.target) {
    throw new Error("Enter a Tailscale IP or bridge URL first");
  }

  if (!state.selectedFileDataUrl) {
    throw new Error("Select an image before submitting");
  }

  state.submissionMarkerVisible = false;
  updateFileUi();
  startSubmitCooldown();
  setHarnessStatus("Submitting print job");

  const payload = await postJson("/api/print", {
    target: settings.target,
    authToken: settings.authToken,
    size: settings.size,
    copies: settings.copies,
    printer: settings.printer,
    jobName: settings.jobName || state.selectedFile.name.replace(/\.[^.]+$/, ""),
    dataUrl: state.selectedFileDataUrl,
  });

  refs.jobJson.textContent = formatJson(payload);
  const acceptedJob = payload.remote?.job || {};
  state.activeJobId = acceptedJob.id || "";
  updateJobSummary(acceptedJob);

  appendLog(
    "Job accepted",
    `Bridge job ${acceptedJob.id || "unknown"} queued on ${payload.target}`,
    "success"
  );
  state.submissionMarkerVisible = true;
  updateFileUi();
  setHarnessStatus("Remote bridge accepted the job", "success");

  clearJobPolling();
  if (state.activeJobId) {
    state.jobTimer = window.setTimeout(pollJob, POLL_INTERVAL_MS);
  }

  inspectBridge(true).catch(() => {});
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Failed to read the selected image"));
    reader.readAsDataURL(file);
  });
}

async function selectFile(file) {
  if (!file) {
    return;
  }

  if (!file.type.startsWith("image/")) {
    throw new Error("Only image files can be submitted from this page");
  }

  state.selectedFile = file;
  state.selectedFileDataUrl = await readFileAsDataUrl(file);
  state.submissionMarkerVisible = false;
  updateFileUi();
  appendLog("Image loaded", `${file.name} is ready for submission`);
}

function bindEvents() {
  refs.bridgeForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
      await inspectBridge(false);
    } catch (error) {
      if (isAuthError(error)) {
        const hasToken = Boolean(refs.authTokenInput.value.trim());
        setAuthMessage(
          hasToken
            ? `Bridge rejected this token (HTTP ${error.status}). Confirm the AUTH_TOKEN set on the bridge.`
            : `This bridge requires an AUTH_TOKEN (got HTTP ${error.status}). Paste the token above and refresh.`,
          "error"
        );
        setHarnessStatus("Auth token required", "error");
      } else {
        setHarnessStatus("Bridge refresh failed", "error");
      }
      appendLog("Bridge snapshot failed", error.message, "error");
    }
  });

  refs.printButton.addEventListener("click", async () => {
    try {
      await handlePrint();
    } catch (error) {
      if (isAuthError(error)) {
        const hasToken = Boolean(refs.authTokenInput.value.trim());
        setAuthMessage(
          hasToken
            ? `Bridge rejected this token (HTTP ${error.status}). Confirm the AUTH_TOKEN set on the bridge.`
            : `This bridge requires an AUTH_TOKEN (got HTTP ${error.status}). Paste the token above and try again.`,
          "error"
        );
        setHarnessStatus("Auth token required", "error");
      } else {
        setHarnessStatus("Print submission failed", "error");
      }
      appendLog("Print submission failed", error.message, "error");
    }
  });

  refs.removeFileButton.addEventListener("click", () => {
    clearSelectedFile();
  });

  refs.clearJobButton.addEventListener("click", () => {
    clearJobView();
  });

  refs.fileInput.addEventListener("change", async (event) => {
    const [file] = event.target.files || [];
    if (!file) {
      return;
    }

    try {
      await selectFile(file);
    } catch (error) {
      appendLog("Image selection failed", error.message, "error");
      clearSelectedFile();
    }
  });

  ["dragenter", "dragover"].forEach((eventName) => {
    refs.dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      refs.dropzone.classList.add("dragover");
    });
  });

  ["dragleave", "dragend", "drop"].forEach((eventName) => {
    refs.dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      refs.dropzone.classList.remove("dragover");
    });
  });

  refs.dropzone.addEventListener("drop", async (event) => {
    const [file] = event.dataTransfer?.files || [];
    if (!file) {
      return;
    }

    try {
      await selectFile(file);
    } catch (error) {
      appendLog("Drop failed", error.message, "error");
      clearSelectedFile();
    }
  });

  [
    refs.targetInput,
    refs.authTokenInput,
    refs.sizeInput,
    refs.copiesInput,
    refs.printerInput,
    refs.jobNameInput,
  ].forEach((input) => {
    input.addEventListener("change", saveSettings);
  });

  refs.authTokenInput.addEventListener("input", () => {
    setAuthMessage("");
  });

  window.addEventListener("beforeunload", () => {
    clearJobPolling();
    clearInspectPolling();
    clearSubmitCooldownTimer();
    saveSettings();
  });
}

function start() {
  applySettings();
  updateFileUi();
  clearJobView();
  bindEvents();

  if (refs.targetInput.value.trim()) {
    inspectBridge(true).catch(() => {});
  }
}

start();
