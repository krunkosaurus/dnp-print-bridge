#!/usr/bin/env node

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");

let DatabaseSync = null;
if (process.env.DB_BACKEND !== "json") {
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    DatabaseSync = null;
  }
}

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3456);
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";
const PRINTER_HINT =
  process.env.PRINTER_NAME || "Dai_Nippon_Printing_DS_RX1";
const DEFAULT_MEDIA = process.env.DEFAULT_MEDIA || "";
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 25 * 1024 * 1024);
const TMP_ROOT = process.env.TMPDIR || os.tmpdir();
const JOB_POLL_MS = Number(process.env.JOB_POLL_MS || 2000);
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 20 * 60 * 1000);
const UI_PREVIEW_MS = Number(process.env.UI_PREVIEW_MS || 10 * 1000);
const WIFI_INTERFACE = process.env.WIFI_INTERFACE || "wlan0";
const TAILSCALE_AUTH_ENABLED = process.env.TAILSCALE_AUTH_ENABLED !== "0";
const TAILSCALE_AUTH_INTERVAL_MS = Number(
  process.env.TAILSCALE_AUTH_INTERVAL_MS || 60 * 1000
);
const TAILSCALE_AUTH_TIMEOUT_MS = Number(
  process.env.TAILSCALE_AUTH_TIMEOUT_MS || 10 * 1000
);
const DB_BACKEND =
  process.env.DB_BACKEND || (DatabaseSync ? "sqlite" : "json");
const DB_PATH =
  process.env.DB_PATH ||
  path.join(
    __dirname,
    "data",
    DB_BACKEND === "sqlite" ? "dnp-print-bridge.sqlite" : "dnp-print-bridge.json"
  );
const LEGACY_JSON_DB_PATH =
  process.env.LEGACY_JSON_DB_PATH ||
  (DB_BACKEND === "sqlite"
    ? path.join(
        path.dirname(DB_PATH),
        `${path.basename(DB_PATH, path.extname(DB_PATH))}.json`
      )
    : DB_PATH);
const STATS_RECENT_LIMIT = Number(process.env.STATS_RECENT_LIMIT || 20);
const PUBLIC_ROOT = path.join(__dirname, "public");

const MIME_EXTENSIONS = {
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
};

const FILE_CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".webp": "image/webp",
};

const FRIENDLY_MEDIA_MAP = {
  "3.5x5": "200dnp5x3.5",
  "5x3.5": "200dnp5x3.5",
  "5x5": "dnp5x5",
  "5x7": "210dnp5x7",
  "4x6": "300dnp6x4",
  "6x4": "300dnp6x4",
  "6x6": "dnp6x6",
  "6x8": "310dnp6x8",
  "8x6": "310dnp6x8",
};

const FRIENDLY_PAGE_SIZE_MAP = {
  "4x6": "w288h432",
  "6x4": "w288h432",
  "5x5": "w360h360",
  "5x7": "w360h504",
  "6x6": "w432h432",
  "6x8": "w432h576",
  "8x6": "w432h576",
};

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

let sqliteDb;
let jsonStore = { jobs: {} };
let nextQueueOrder = 1;
const jobs = new Map();
const queuedJobIds = [];
let activeJobId = null;
let queueWorkerRunning = false;
let activePreview = null;
let previewTimer = null;
let tailscaleStateCache = {
  fetchedAt: 0,
  state: {
    ips: [],
    connected: false,
    backendState: "UNKNOWN",
    authRequired: false,
    authUrl: "",
    authQr: "",
    error: null,
  },
};
let tailscaleAuthAttempt = {
  attemptedAt: 0,
  authUrl: "",
  authQr: "",
  error: null,
};
let wifiCache = {
  fetchedAt: 0,
  state: {
    interface: WIFI_INTERFACE,
    ssid: null,
    wpaState: "UNKNOWN",
    connected: false,
  },
};

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function spawnAndCollectFirstAvailable(commands, args) {
  let lastError = null;

  for (const command of commands) {
    try {
      return await spawnAndCollect(command, args);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`Unable to run command: ${commands.join(", ")}`);
}

function spawnAndCollect(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timeout = null;
    let killTimeout = null;

    if (options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimeout = setTimeout(() => child.kill("SIGKILL"), 2000);
      }, options.timeoutMs);
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (killTimeout) {
        clearTimeout(killTimeout);
      }
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (killTimeout) {
        clearTimeout(killTimeout);
      }
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
      });
    });
  });
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, `Request body exceeded ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

function assertAuthorized(req) {
  if (!AUTH_TOKEN) {
    return;
  }

  const header = req.headers.authorization || "";
  const expected = `Bearer ${AUTH_TOKEN}`;
  if (header !== expected) {
    throw new HttpError(401, "Unauthorized");
  }
}

function extensionForMime(contentType) {
  return MIME_EXTENSIONS[String(contentType || "").toLowerCase()] || ".bin";
}

function contentTypeForFilePath(filePath) {
  return FILE_CONTENT_TYPES[path.extname(String(filePath || "")).toLowerCase()] ||
    "application/octet-stream";
}

function normalizeBase64(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    return { data: "", contentType: "" };
  }

  const match = raw.match(/^data:([^;]+);base64,(.+)$/);
  if (match) {
    return {
      contentType: match[1],
      data: match[2],
    };
  }

  return { data: raw, contentType: "" };
}

function sanitizeJobName(value) {
  return String(value || "photo-job")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "photo-job";
}

function normalizeFriendlyMedia(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  const normalized = raw.toLowerCase().replace(/\s+/g, "");
  return FRIENDLY_MEDIA_MAP[normalized] || raw;
}

function normalizeFriendlyPageSize(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  const normalized = raw.toLowerCase().replace(/\s+/g, "");
  return FRIENDLY_PAGE_SIZE_MAP[normalized] || raw;
}

function parseCupsRequestId(lpOutput) {
  const match = String(lpOutput || "").match(/request id is (\S+) \(/);
  return match ? match[1] : null;
}

function normalizePrinterToken(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function buildPrinterRecord(name, status) {
  const normalizedStatus = String(status || "").trim();
  return {
    name,
    status: normalizedStatus,
    enabled: !/\bdisabled\b/i.test(normalizedStatus),
    busy: /\bnow printing\b/i.test(normalizedStatus),
  };
}

function scorePrinterMatch(printer, hint) {
  if (!printer?.enabled) {
    return -1;
  }

  const rawHint = String(hint || "").trim();
  if (!rawHint) {
    return 0;
  }

  const normalizedHint = normalizePrinterToken(rawHint);
  if (!normalizedHint) {
    return 0;
  }

  const normalizedName = normalizePrinterToken(printer.name);
  const exactName = printer.name === rawHint;
  const exactNormalized = normalizedName === normalizedHint;
  const rawPrefix = printer.name.startsWith(rawHint);
  const normalizedPrefix = normalizedName.startsWith(normalizedHint);
  const rawContains =
    printer.name.includes(rawHint) || rawHint.includes(printer.name);
  const normalizedContains =
    normalizedName.includes(normalizedHint) ||
    normalizedHint.includes(normalizedName);

  if (exactName) {
    return 100;
  }

  if (exactNormalized) {
    return 95;
  }

  if (rawPrefix) {
    return 90;
  }

  if (normalizedPrefix) {
    return 85;
  }

  if (rawContains) {
    return 80;
  }

  if (normalizedContains) {
    return 75;
  }

  return 0;
}

function selectPrinter(printers, hint = PRINTER_HINT) {
  const availablePrinters = printers.filter((printer) => printer?.name);
  const enabledPrinters = availablePrinters.filter((printer) => printer.enabled);

  if (enabledPrinters.length === 0) {
    return null;
  }

  const rankedMatches = enabledPrinters
    .map((printer) => ({
      printer,
      score: scorePrinterMatch(printer, hint),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);

  if (rankedMatches.length > 0) {
    return rankedMatches[0].printer;
  }

  if (enabledPrinters.length === 1) {
    return enabledPrinters[0];
  }

  const dnpLikePrinters = enabledPrinters.filter((printer) =>
    /\bdnp\b|dai[_ -]?nippon/i.test(printer.name)
  );
  if (dnpLikePrinters.length === 1) {
    return dnpLikePrinters[0];
  }

  return null;
}

function normalizeJsonStore(store) {
  if (!store || typeof store !== "object" || Array.isArray(store)) {
    return { jobs: {} };
  }

  if (!store.jobs || typeof store.jobs !== "object" || Array.isArray(store.jobs)) {
    store.jobs = {};
  }

  return store;
}

function writeJsonStoreFile(targetPath, store) {
  const tempPath = `${targetPath}.tmp`;
  fsSync.writeFileSync(tempPath, JSON.stringify(store, null, 2));
  fsSync.renameSync(tempPath, targetPath);
}

function loadJsonStoreWithRecovery(jsonPath = DB_PATH) {
  const raw = fsSync.readFileSync(jsonPath, "utf8");
  const trimmed = raw.trim();
  if (!trimmed) {
    return { jobs: {} };
  }

  try {
    return normalizeJsonStore(JSON.parse(trimmed));
  } catch (error) {
    const sanitized = trimmed.replace(/\u0000+/g, "");
    if (sanitized === trimmed) {
      throw error;
    }

    const recovered = normalizeJsonStore(JSON.parse(sanitized));
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${jsonPath}.corrupt-${timestamp}`;
    fsSync.copyFileSync(jsonPath, backupPath);
    writeJsonStoreFile(jsonPath, recovered);
    console.warn(
      `Recovered JSON database from NUL-byte corruption and backed up the original to ${backupPath}`
    );
    return recovered;
  }
}

function countSqliteJobs() {
  if (!sqliteDb) {
    return 0;
  }

  const row = sqliteDb.prepare("SELECT COUNT(*) AS total FROM jobs").get();
  return Number(row?.total || 0);
}

function upsertSqliteJob(job) {
  sqliteDb
    .prepare(
      `
        INSERT INTO jobs (
          id,
          queue_order,
          status,
          printer,
          job_name,
          copies,
          requested_size,
          media,
          payload_json,
          file_path,
          cleanup_dir,
          cups_request_id,
          error,
          created_at,
          started_at,
          completed_at,
          is_terminal
        ) VALUES (
          @id,
          @queue_order,
          @status,
          @printer,
          @job_name,
          @copies,
          @requested_size,
          @media,
          @payload_json,
          @file_path,
          @cleanup_dir,
          @cups_request_id,
          @error,
          @created_at,
          @started_at,
          @completed_at,
          @is_terminal
        )
        ON CONFLICT(id) DO UPDATE SET
          queue_order = excluded.queue_order,
          status = excluded.status,
          printer = excluded.printer,
          job_name = excluded.job_name,
          copies = excluded.copies,
          requested_size = excluded.requested_size,
          media = excluded.media,
          payload_json = excluded.payload_json,
          file_path = excluded.file_path,
          cleanup_dir = excluded.cleanup_dir,
          cups_request_id = excluded.cups_request_id,
          error = excluded.error,
          created_at = excluded.created_at,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          is_terminal = excluded.is_terminal
      `
    )
    .run({
      id: job.id,
      queue_order: job.queueOrder,
      status: job.status,
      printer: job.printer,
      job_name: job.jobName,
      copies: job.copies,
      requested_size: job.requestedSize || "",
      media: job.media || "",
      payload_json: JSON.stringify(job.payload),
      file_path: job.filePath || null,
      cleanup_dir: job.cleanupDir || null,
      cups_request_id: job.cupsRequestId || null,
      error: job.error || null,
      created_at: job.createdAt,
      started_at: job.startedAt || null,
      completed_at: job.completedAt || null,
      is_terminal: job.isTerminal ? 1 : 0,
    });
}

function migrateLegacyJsonStoreToSqlite() {
  if (
    LEGACY_JSON_DB_PATH === DB_PATH ||
    !fsSync.existsSync(LEGACY_JSON_DB_PATH) ||
    countSqliteJobs() > 0
  ) {
    return 0;
  }

  const legacyStore = loadJsonStoreWithRecovery(LEGACY_JSON_DB_PATH);
  const legacyJobs = Object.values(legacyStore.jobs || {})
    .map(hydrateJsonJob)
    .sort(compareJobs);

  for (const job of legacyJobs) {
    upsertSqliteJob(job);
  }

  if (legacyJobs.length > 0) {
    console.log(
      `Migrated ${legacyJobs.length} jobs from ${LEGACY_JSON_DB_PATH} to ${DB_PATH}`
    );
  }

  return legacyJobs.length;
}

async function initDatabase() {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
  if (DB_BACKEND === "sqlite") {
    sqliteDb = new DatabaseSync(DB_PATH);
    sqliteDb.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        queue_order INTEGER NOT NULL,
        status TEXT NOT NULL,
        printer TEXT NOT NULL,
        job_name TEXT NOT NULL,
        copies INTEGER NOT NULL,
        requested_size TEXT,
        media TEXT,
        payload_json TEXT NOT NULL,
        file_path TEXT,
        cleanup_dir TEXT,
        cups_request_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        is_terminal INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_queue_order ON jobs(queue_order);
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_completed_at ON jobs(completed_at);
    `);
    migrateLegacyJsonStoreToSqlite();
  } else if (fsSync.existsSync(DB_PATH)) {
    jsonStore = loadJsonStoreWithRecovery();
  } else {
    jsonStore = { jobs: {} };
    writeJsonStore();
  }

  const persistedJobs = loadPersistedJobs();
  const highestQueueOrder = persistedJobs.reduce(
    (max, job) => Math.max(max, Number(job.queueOrder || 0)),
    0
  );
  nextQueueOrder = highestQueueOrder + 1;
}

function serializeJob(job) {
  return {
    id: job.id,
    queueOrder: Number(job.queueOrder),
    status: job.status,
    printer: job.printer,
    jobName: job.jobName,
    copies: Number(job.copies),
    requestedSize: job.requestedSize || "",
    media: job.media || "",
    payload: job.payload,
    filePath: job.filePath || null,
    cleanupDir: job.cleanupDir || null,
    cupsRequestId: job.cupsRequestId || null,
    error: job.error || null,
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    completedAt: job.completedAt || null,
    isTerminal: Boolean(job.isTerminal),
  };
}

function hydrateJsonJob(record) {
  return {
    id: record.id,
    queueOrder: Number(record.queueOrder),
    status: record.status,
    printer: record.printer,
    jobName: record.jobName,
    copies: Number(record.copies),
    requestedSize: record.requestedSize || "",
    media: record.media || "",
    payload: record.payload,
    filePath: record.filePath || null,
    cleanupDir: record.cleanupDir || null,
    cupsRequestId: record.cupsRequestId || null,
    error: record.error || null,
    createdAt: record.createdAt,
    startedAt: record.startedAt || null,
    completedAt: record.completedAt || null,
    isTerminal: Boolean(record.isTerminal),
  };
}

function compareJobs(left, right) {
  return (
    Number(left.queueOrder) - Number(right.queueOrder) ||
    String(left.createdAt || "").localeCompare(String(right.createdAt || ""))
  );
}

function formatLocalDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getPrintedTodayCount() {
  const todayKey = formatLocalDateKey(new Date());
  return Array.from(jobs.values()).filter((job) => {
    if (job.status !== "completed" || !job.completedAt) {
      return false;
    }

    const completedAt = new Date(job.completedAt);
    if (Number.isNaN(completedAt.getTime())) {
      return false;
    }

    return formatLocalDateKey(completedAt) === todayKey;
  }).length;
}

function clearActivePreview() {
  if (!activePreview) {
    return;
  }

  const expiredPreview = activePreview;
  activePreview = null;

  const job = jobs.get(expiredPreview.jobId);
  if (job?.isTerminal) {
    finalizeJobFile(job);
  }
}

function getActivePreview() {
  if (!activePreview) {
    return null;
  }

  if (Date.now() >= activePreview.expiresAt) {
    clearActivePreview();
    return null;
  }

  return activePreview;
}

function schedulePreviewExpiry() {
  if (previewTimer) {
    clearTimeout(previewTimer);
    previewTimer = null;
  }

  const preview = getActivePreview();
  if (!preview) {
    return;
  }

  previewTimer = setTimeout(() => {
    previewTimer = null;
    clearActivePreview();
  }, Math.max(0, preview.expiresAt - Date.now()) + 25);
}

function rememberPreview(job) {
  const existingPreview = getActivePreview();
  if (existingPreview && existingPreview.jobId !== job.id) {
    const existingJob = jobs.get(existingPreview.jobId);
    activePreview = null;
    if (existingJob?.isTerminal) {
      finalizeJobFile(existingJob);
    }
  }

  activePreview = {
    jobId: job.id,
    filePath: job.filePath,
    contentType: contentTypeForFilePath(job.filePath),
    expiresAt: Date.now() + UI_PREVIEW_MS,
  };
  schedulePreviewExpiry();
}

function previewRetainsJobFile(job) {
  const preview = getActivePreview();
  return Boolean(preview && preview.jobId === job.id && preview.filePath === job.filePath);
}

function stripAnsi(value) {
  return String(value || "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function extractTailscaleAuthUrl(value) {
  return (
    stripAnsi(value).match(/https:\/\/login\.tailscale\.com\/[^\s"'<>]+/)?.[0] ||
    ""
  );
}

function extractQrBlock(value) {
  const lines = stripAnsi(value)
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""));
  const qrLines = lines.filter((line) => /[█▀▄]/.test(line));

  if (qrLines.length < 8) {
    return "";
  }

  return qrLines.join("\n");
}

function parseTailscaleIps(status) {
  return (status?.TailscaleIPs || [])
    .map((ip) => String(ip || "").trim())
    .filter((ip) => ip.includes("."));
}

function getInterfaceIpv4s(interfaceName) {
  return (os.networkInterfaces()[interfaceName] || [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address)
    .filter(Boolean);
}

async function requestTailscaleAuth() {
  const args = ["up", "--qr", "--qr-format=small", "--timeout=5s"];
  const commands = [
    { command: "tailscale", args },
    { command: "sudo", args: ["-n", "tailscale", ...args] },
  ];
  let lastOutput = "";
  let lastError = null;

  for (const entry of commands) {
    const result = await spawnAndCollect(entry.command, entry.args, {
      timeoutMs: TAILSCALE_AUTH_TIMEOUT_MS,
    }).catch((error) => {
      lastError = error;
      return null;
    });

    if (!result) {
      continue;
    }

    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    lastOutput = output || lastOutput;
    const authUrl = extractTailscaleAuthUrl(output);
    const authQr = extractQrBlock(output);

    if (authUrl || result.code === 0) {
      return {
        authUrl,
        authQr,
        error: result.code === 0 ? null : output || null,
      };
    }

    if (!/permission|sudo|root|not authorized|access denied/i.test(output)) {
      break;
    }
  }

  return {
    authUrl: "",
    authQr: "",
    error: lastOutput || lastError?.message || "Unable to request Tailscale auth URL",
  };
}

async function getTailscaleState() {
  const now = Date.now();
  if (now - tailscaleStateCache.fetchedAt < 5 * 1000) {
    return tailscaleStateCache.state;
  }

  tailscaleStateCache.fetchedAt = now;
  const result = await spawnAndCollect("tailscale", ["status", "--json"], {
    timeoutMs: 8 * 1000,
  }).catch((error) => ({
    code: 1,
    stdout: "",
    stderr: error.message,
  }));
  let status = null;
  let parseError = null;

  if (result.code === 0) {
    try {
      status = JSON.parse(result.stdout);
    } catch (error) {
      parseError = error.message;
    }
  }

  const ips = parseTailscaleIps(status);
  const backendState = status?.BackendState || (result.code === 0 ? "UNKNOWN" : "UNAVAILABLE");
  const connected = backendState === "Running" && ips.length > 0;
  let authUrl = status?.AuthURL || "";
  let authQr = "";
  let authError = null;
  const needsLogin = ["NeedsLogin", "NoState", "Stopped"].includes(backendState);

  if (!connected && TAILSCALE_AUTH_ENABLED && needsLogin) {
    const shouldRefreshAuth =
      (!authUrl || !tailscaleAuthAttempt.authQr) &&
      now - tailscaleAuthAttempt.attemptedAt >= TAILSCALE_AUTH_INTERVAL_MS;

    if (shouldRefreshAuth) {
      tailscaleAuthAttempt.attemptedAt = now;
      const auth = await requestTailscaleAuth();
      tailscaleAuthAttempt = {
        attemptedAt: now,
        authUrl: auth.authUrl || authUrl,
        authQr: auth.authQr,
        error: auth.error,
      };
    }

    authUrl = authUrl || tailscaleAuthAttempt.authUrl;
    authQr = tailscaleAuthAttempt.authQr;
    authError = tailscaleAuthAttempt.error;
  }

  if (connected) {
    tailscaleAuthAttempt = {
      attemptedAt: 0,
      authUrl: "",
      authQr: "",
      error: null,
    };
  }

  tailscaleStateCache.state = {
    ips,
    connected,
    backendState,
    authRequired: !connected && Boolean(authUrl || needsLogin),
    authUrl,
    authQr,
    error: authError || parseError || (result.code === 0 ? null : result.stderr || "tailscale status failed"),
    checkedAt: new Date().toISOString(),
  };

  return tailscaleStateCache.state;
}

async function getWifiStatus() {
  const now = Date.now();
  if (now - wifiCache.fetchedAt < 10 * 1000) {
    return wifiCache.state;
  }

  wifiCache.fetchedAt = now;
  const result = await spawnAndCollectFirstAvailable(
    ["/usr/sbin/wpa_cli", "/sbin/wpa_cli", "wpa_cli"],
    ["-i", WIFI_INTERFACE, "status"]
  ).catch(() => ({
    code: 1,
    stdout: "",
    stderr: "",
  }));

  if (result.code !== 0) {
    wifiCache.state = {
      interface: WIFI_INTERFACE,
      ssid: null,
      wpaState: "UNAVAILABLE",
      connected: false,
      ips: getInterfaceIpv4s(WIFI_INTERFACE),
    };
    return wifiCache.state;
  }

  const fields = {};
  for (const line of result.stdout.split("\n")) {
    const [key, ...rest] = line.split("=");
    if (!key || rest.length === 0) {
      continue;
    }
    fields[key] = rest.join("=").trim();
  }

  const ssid = fields.ssid || null;
  const wpaState = fields.wpa_state || "UNKNOWN";

  wifiCache.state = {
    interface: WIFI_INTERFACE,
    ssid,
    wpaState,
    connected: Boolean(ssid && wpaState === "COMPLETED"),
    ips: getInterfaceIpv4s(WIFI_INTERFACE),
  };

  return wifiCache.state;
}

function writeJsonStore() {
  writeJsonStoreFile(DB_PATH, jsonStore);
}

function loadPersistedJobs() {
  if (DB_BACKEND === "sqlite") {
    return sqliteDb
      .prepare("SELECT * FROM jobs ORDER BY queue_order ASC, created_at ASC")
      .all()
      .map(hydrateJob);
  }

  return Object.values(jsonStore.jobs || {})
    .map(hydrateJsonJob)
    .sort(compareJobs);
}

function persistJob(job) {
  if (DB_BACKEND === "sqlite") {
    upsertSqliteJob(job);
    return;
  }

  jsonStore.jobs[job.id] = serializeJob(job);
  writeJsonStore();
}

function hydrateJob(row) {
  return {
    id: row.id,
    queueOrder: Number(row.queue_order),
    status: row.status,
    printer: row.printer,
    jobName: row.job_name,
    copies: Number(row.copies),
    requestedSize: row.requested_size || "",
    media: row.media || "",
    payload: JSON.parse(row.payload_json),
    filePath: row.file_path || null,
    cleanupDir: row.cleanup_dir || null,
    cupsRequestId: row.cups_request_id || null,
    error: row.error || null,
    createdAt: row.created_at,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    isTerminal: Boolean(row.is_terminal),
  };
}

function updateJob(job, updates) {
  Object.assign(job, updates);
  persistJob(job);
}

function computeJobsAhead(jobId) {
  let count = 0;

  if (activeJobId && activeJobId !== jobId) {
    const activeJob = jobs.get(activeJobId);
    if (activeJob && !activeJob.isTerminal) {
      count += 1;
    }
  }

  for (const queuedJobId of queuedJobIds) {
    if (queuedJobId === jobId) {
      break;
    }
    const queuedJob = jobs.get(queuedJobId);
    if (queuedJob && !queuedJob.isTerminal) {
      count += 1;
    }
  }

  return count;
}

function buildJobResponse(job) {
  return {
    id: job.id,
    status: job.status,
    printer: job.printer,
    jobName: job.jobName,
    copies: job.copies,
    size: job.requestedSize || null,
    media: job.media || null,
    jobsAhead: computeJobsAhead(job.id),
    cupsRequestId: job.cupsRequestId || null,
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    completedAt: job.completedAt || null,
    error: job.error || null,
  };
}

function buildRecentJobResponse(row) {
  return {
    id: row.id,
    status: row.status,
    printer: row.printer,
    jobName: row.job_name,
    copies: Number(row.copies),
    size: row.requested_size || null,
    media: row.media || null,
    cupsRequestId: row.cups_request_id || null,
    createdAt: row.created_at,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    error: row.error || null,
  };
}

async function writePrintFile(payload) {
  if (payload.data || payload.dataUrl) {
    const tempDir = await fs.mkdtemp(path.join(TMP_ROOT, "dnp-print-"));
    const jobName = sanitizeJobName(payload.jobName);
    const parsedBase64 = normalizeBase64(payload.data || payload.dataUrl);
    const contentType = payload.contentType || parsedBase64.contentType;
    const extension = extensionForMime(contentType);
    const filePath = path.join(
      tempDir,
      `${jobName}-${randomUUID()}${extension}`
    );
    await fs.writeFile(filePath, Buffer.from(parsedBase64.data, "base64"));
    return { filePath, cleanupDir: tempDir };
  }

  if (payload.url) {
    let response;
    try {
      response = await fetch(payload.url);
    } catch {
      throw new HttpError(502, "Failed to fetch remote file");
    }

    if (!response.ok) {
      throw new HttpError(502, `Fetch failed with HTTP ${response.status}`);
    }

    const tempDir = await fs.mkdtemp(path.join(TMP_ROOT, "dnp-print-"));
    const jobName = sanitizeJobName(payload.jobName);
    const contentType = payload.contentType || response.headers.get("content-type");
    const extension = extensionForMime(contentType);
    const filePath = path.join(
      tempDir,
      `${jobName}-${randomUUID()}${extension}`
    );
    const arrayBuffer = await response.arrayBuffer();
    await fs.writeFile(filePath, Buffer.from(arrayBuffer));
    return { filePath, cleanupDir: tempDir };
  }

  if (payload.filePath) {
    const filePath = String(payload.filePath);
    try {
      await fs.access(filePath);
    } catch {
      throw new HttpError(400, "filePath does not exist or is not readable");
    }
    return { filePath, cleanupDir: null };
  }

  throw new HttpError(400, "Provide one of: data, dataUrl, url, or filePath");
}

async function ensurePrintableFile(job) {
  if (job.filePath) {
    try {
      await fs.access(job.filePath);
      return;
    } catch {
      // Rebuild below.
    }
  }

  const written = await writePrintFile(job.payload);
  updateJob(job, {
    filePath: written.filePath,
    cleanupDir: written.cleanupDir,
  });
}

async function resolvePrinterName(requestedPrinter = "") {
  if (requestedPrinter) {
    return requestedPrinter;
  }

  const printers = await listPrinters();
  const selectedPrinter = selectPrinter(printers, PRINTER_HINT);
  if (selectedPrinter) {
    return selectedPrinter.name;
  }

  if (PRINTER_HINT) {
    throw new HttpError(
      503,
      `No enabled printer found matching "${PRINTER_HINT}"`
    );
  }

  throw new HttpError(503, "No enabled printer found");
}

async function getResolvedDefaultPrinter() {
  try {
    return await resolvePrinterName();
  } catch {
    return null;
  }
}

async function getPrinterOptionChoices(printer) {
  const result = await spawnAndCollect("lpoptions", ["-p", printer, "-l"]);
  if (result.code !== 0) {
    return {};
  }

  const choicesByOption = {};

  for (const rawLine of result.stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line || !line.includes(":")) {
      continue;
    }

    const [descriptor, values] = line.split(":", 2);
    const optionName = descriptor.split("/", 1)[0].trim();
    if (!optionName || !values) {
      continue;
    }

    choicesByOption[optionName] = values
      .trim()
      .split(/\s+/)
      .map((value) => value.replace(/^\*/, ""))
      .filter(Boolean);
  }

  return choicesByOption;
}

async function buildLpArgs(payload, filePath) {
  const printer = await resolvePrinterName(payload.printer);

  const args = ["-d", printer];
  const jobName = sanitizeJobName(payload.jobName);
  args.push("-t", jobName);

  const copies = Number(payload.copies || 1);
  if (!Number.isInteger(copies) || copies < 1 || copies > 99) {
    throw new HttpError(400, "copies must be an integer between 1 and 99");
  }
  args.push("-n", String(copies));

  const options = { ...(payload.options || {}) };
  const requestedOutput = payload.media || payload.size || DEFAULT_MEDIA;
  const media = normalizeFriendlyMedia(requestedOutput);
  const pageSize = normalizeFriendlyPageSize(requestedOutput);
  const optionChoices = await getPrinterOptionChoices(printer);
  const supportedPageSizes = new Set(optionChoices.PageSize || []);

  if (pageSize && supportedPageSizes.has(pageSize)) {
    options.PageSize = pageSize;
  } else if (media) {
    options.media = media;
  }

  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    args.push("-o", `${key}=${value}`);
  }

  args.push(filePath);
  return {
    printer,
    args,
    media: options.PageSize || media,
    jobName,
    copies,
  };
}

async function listPrinters() {
  const result = await spawnAndCollect("lpstat", ["-p"]);
  if (result.code !== 0) {
    throw new HttpError(500, result.stderr || "lpstat -p failed");
  }

  const printers = [];
  let currentPrinter = null;

  for (const rawLine of result.stdout.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const match = trimmed.match(/^printer\s+(\S+)\s+(.+)$/);
    if (match) {
      currentPrinter = buildPrinterRecord(match[1], match[2]);
      printers.push(currentPrinter);
      continue;
    }

    if (currentPrinter && /^\s+/.test(line)) {
      Object.assign(
        currentPrinter,
        buildPrinterRecord(
          currentPrinter.name,
          `${currentPrinter.status} ${trimmed}`
        )
      );
      continue;
    }

    printers.push({ raw: trimmed });
    currentPrinter = null;
  }

  return printers;
}

async function listOutstandingCupsJobs(printer) {
  const result = await spawnAndCollect("lpstat", [
    "-W",
    "not-completed",
    "-o",
    printer,
  ]);

  if (result.code !== 0) {
    throw new Error(result.stderr || "lpstat -W not-completed failed");
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[0]);
}

async function waitForCupsJobToFinish(job) {
  const deadline = Date.now() + JOB_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const outstanding = await listOutstandingCupsJobs(job.printer);
    if (!outstanding.includes(job.cupsRequestId)) {
      return;
    }
    await sleep(JOB_POLL_MS);
  }

  throw new Error(
    `Timed out waiting for CUPS job ${job.cupsRequestId} to finish`
  );
}

function finalizeJobFile(job) {
  if (previewRetainsJobFile(job)) {
    return;
  }

  if (!job.cleanupDir) {
    return;
  }

  const cleanupDir = job.cleanupDir;
  job.filePath = null;
  job.cleanupDir = null;
  persistJob(job);
  fs.rm(cleanupDir, { recursive: true, force: true }).catch(() => {});
}

function markJobCompleted(job) {
  updateJob(job, {
    status: "completed",
    completedAt: job.completedAt || new Date().toISOString(),
    isTerminal: true,
    error: null,
  });
  finalizeJobFile(job);
}

function markJobFailed(job, message) {
  updateJob(job, {
    status: "failed",
    completedAt: new Date().toISOString(),
    isTerminal: true,
    error: message,
  });
  finalizeJobFile(job);
}

function buildUiPreviewResponse() {
  const preview = getActivePreview();
  if (!preview) {
    return null;
  }

  const job = jobs.get(preview.jobId);
  if (!job) {
    return null;
  }

  const imagePreview = /^image\//.test(preview.contentType || "");

  return {
    jobId: job.id,
    jobName: job.jobName,
    printer: job.printer,
    status: job.status,
    createdAt: job.createdAt,
    expiresAt: new Date(preview.expiresAt).toISOString(),
    remainingMs: Math.max(0, preview.expiresAt - Date.now()),
    imageUrl: imagePreview
      ? `/ui/preview/current?t=${preview.expiresAt}`
      : null,
    contentType: imagePreview ? preview.contentType : null,
  };
}

async function buildUiState() {
  const printers = await listPrinters().catch(() => []);
  const resolvedPrinter = selectPrinter(printers, PRINTER_HINT)?.name || null;
  const printer =
    printers.find((entry) => entry?.name === resolvedPrinter) || null;
  const preview = buildUiPreviewResponse();
  const activeJob = activeJobId ? jobs.get(activeJobId) || null : null;
  const tailscale = await getTailscaleState();
  const openJobs = Array.from(jobs.values()).filter((job) =>
    ["queued", "submitting", "printing"].includes(job.status)
  ).length;

  return {
    hostname: os.hostname(),
    online: true,
    status: preview ? "PRINTING" : "READY",
    wifi: await getWifiStatus(),
    tailscale,
    tailscaleIps: tailscale.ips,
    printedToday: getPrintedTodayCount(),
    defaultPrinter: resolvedPrinter,
    printer,
    activeJob: activeJob ? buildJobResponse(activeJob) : null,
    queue: {
      activeJobId,
      queued: queuedJobIds.length,
      openJobs,
      knownJobs: jobs.size,
    },
    preview,
    dbBackend: DB_BACKEND,
    updatedAt: new Date().toISOString(),
  };
}

function resolvePublicPath(urlPathname) {
  const relativePath =
    urlPathname === "/" ? "index.html" : decodeURIComponent(urlPathname.replace(/^\/+/, ""));
  const absolutePath = path.resolve(PUBLIC_ROOT, relativePath);
  if (!absolutePath.startsWith(`${PUBLIC_ROOT}${path.sep}`) && absolutePath !== path.join(PUBLIC_ROOT, "index.html")) {
    throw new HttpError(403, "Forbidden");
  }
  return absolutePath;
}

async function servePublicFile(res, urlPathname) {
  const filePath = resolvePublicPath(urlPathname);
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    throw new HttpError(404, "Not found");
  }

  if (!stat.isFile()) {
    throw new HttpError(404, "Not found");
  }

  const payload = await fs.readFile(filePath);
  res.writeHead(200, {
    "content-type": contentTypeForFilePath(filePath),
    "content-length": payload.length,
    "cache-control": filePath.endsWith("index.html")
      ? "no-store"
      : "public, max-age=300",
  });
  res.end(payload);
}

async function servePreviewFile(res) {
  const preview = getActivePreview();
  if (!preview || !preview.filePath) {
    throw new HttpError(404, "No active preview");
  }

  let payload;
  try {
    payload = await fs.readFile(preview.filePath);
  } catch {
    throw new HttpError(404, "Preview file not found");
  }

  res.writeHead(200, {
    "content-type": preview.contentType || contentTypeForFilePath(preview.filePath),
    "content-length": payload.length,
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function runJob(job, options = {}) {
  const skipSubmission = Boolean(options.skipSubmission);
  activeJobId = job.id;

  try {
    if (skipSubmission) {
      updateJob(job, {
        status: "printing",
        startedAt: job.startedAt || new Date().toISOString(),
        isTerminal: false,
      });
    } else {
      updateJob(job, {
        status: "submitting",
        startedAt: job.startedAt || new Date().toISOString(),
        completedAt: null,
        error: null,
        isTerminal: false,
      });

      await ensurePrintableFile(job);
      const submission = await buildLpArgs(job.payload, job.filePath);
      updateJob(job, {
        printer: submission.printer,
      });
      const result = await spawnAndCollect("lp", submission.args);

      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout || "lp failed");
      }

      const cupsRequestId = parseCupsRequestId(result.stdout);
      if (!cupsRequestId) {
        throw new Error("Unable to parse CUPS request id from lp output");
      }

      updateJob(job, {
        status: "printing",
        cupsRequestId,
      });
    }

    await waitForCupsJobToFinish(job);
    markJobCompleted(job);
  } catch (error) {
    markJobFailed(job, error.message);
  } finally {
    activeJobId = null;
    kickQueueWorker();
  }
}

function kickQueueWorker() {
  processNextJob().catch((error) => {
    console.error("queue worker error:", error);
  });
}

async function processNextJob() {
  if (queueWorkerRunning || activeJobId) {
    return;
  }

  queueWorkerRunning = true;

  try {
    while (!activeJobId && queuedJobIds.length > 0) {
      const nextJobId = queuedJobIds.shift();
      const job = jobs.get(nextJobId);
      if (!job || job.isTerminal) {
        continue;
      }

      await runJob(job);
    }
  } finally {
    queueWorkerRunning = false;
  }
}

async function restoreJobsFromDatabase() {
  jobs.clear();
  queuedJobIds.length = 0;
  activeJobId = null;

  const persistedJobs = loadPersistedJobs();
  const outstandingCache = new Map();

  async function getOutstanding(printer) {
    if (!outstandingCache.has(printer)) {
      outstandingCache.set(printer, await listOutstandingCupsJobs(printer));
    }
    return outstandingCache.get(printer);
  }

  for (const job of persistedJobs) {
    jobs.set(job.id, job);
  }

  for (const job of jobs.values()) {
    if (job.isTerminal || job.status === "completed" || job.status === "failed") {
      job.isTerminal = true;
      persistJob(job);
      finalizeJobFile(job);
      continue;
    }

    if (job.status === "queued" || (job.status === "submitting" && !job.cupsRequestId)) {
      updateJob(job, {
        status: "queued",
        startedAt: null,
        completedAt: null,
        error: null,
        isTerminal: false,
      });
      queuedJobIds.push(job.id);
      continue;
    }

    if (job.cupsRequestId) {
      const outstanding = await getOutstanding(job.printer);
      if (outstanding.includes(job.cupsRequestId) && !activeJobId) {
        updateJob(job, {
          status: "printing",
          isTerminal: false,
        });
        activeJobId = job.id;
        continue;
      }

      if (outstanding.includes(job.cupsRequestId) && activeJobId) {
        markJobFailed(job, "Multiple active bridge jobs found during recovery");
        continue;
      }

      markJobCompleted(job);
      continue;
    }

    updateJob(job, {
      status: "queued",
      startedAt: null,
      completedAt: null,
      error: null,
      isTerminal: false,
    });
    queuedJobIds.push(job.id);
  }

  if (activeJobId) {
    const activeJob = jobs.get(activeJobId);
    if (activeJob) {
      runJob(activeJob, { skipSubmission: true }).catch((error) => {
        console.error("recovery worker error:", error);
      });
    }
  }

  kickQueueWorker();
}

function getStats(limit = STATS_RECENT_LIMIT) {
  const allJobs = Array.from(jobs.values());
  const totals = allJobs.reduce(
    (acc, job) => {
      acc.totalJobs += 1;
      if (job.status === "completed") {
        acc.completedJobs += 1;
      } else if (job.status === "failed") {
        acc.failedJobs += 1;
      } else if (["queued", "submitting", "printing"].includes(job.status)) {
        acc.openJobs += 1;
      }
      return acc;
    },
    {
      totalJobs: 0,
      completedJobs: 0,
      failedJobs: 0,
      openJobs: 0,
    }
  );

  const recentJobs = allJobs
    .slice()
    .sort((left, right) => compareJobs(right, left))
    .slice(0, limit)
    .map((job) =>
      buildRecentJobResponse({
        id: job.id,
        status: job.status,
        printer: job.printer,
        job_name: job.jobName,
        copies: job.copies,
        requested_size: job.requestedSize,
        media: job.media,
        cups_request_id: job.cupsRequestId,
        created_at: job.createdAt,
        started_at: job.startedAt,
        completed_at: job.completedAt,
        error: job.error,
      })
    );

  return {
    dbBackend: DB_BACKEND,
    dbPath: DB_PATH,
    totalJobs: totals.totalJobs,
    completedJobs: totals.completedJobs,
    failedJobs: totals.failedJobs,
    openJobs: totals.openJobs,
    activeJobId,
    queuedJobs: queuedJobIds.length,
    recentJobs,
  };
}

async function handlePrint(req, res) {
  assertAuthorized(req);
  const payload = await readJsonBody(req);
  const written = await writePrintFile(payload);
  const preview = await buildLpArgs(payload, written.filePath);
  const storedPayload = {
    ...payload,
    printer: preview.printer,
  };
  const now = new Date().toISOString();
  const job = {
    id: randomUUID(),
    queueOrder: nextQueueOrder++,
    status: "queued",
    printer: preview.printer,
    jobName: preview.jobName,
    copies: preview.copies,
    requestedSize: payload.size || payload.media || DEFAULT_MEDIA || "",
    media: preview.media || "",
    payload: storedPayload,
    filePath: written.filePath,
    cleanupDir: written.cleanupDir,
    cupsRequestId: null,
    error: null,
    createdAt: now,
    startedAt: null,
    completedAt: null,
    isTerminal: false,
  };

  jobs.set(job.id, job);
  rememberPreview(job);
  persistJob(job);
  queuedJobIds.push(job.id);
  kickQueueWorker();

  sendJson(res, 202, {
    ok: true,
    message: "Job accepted and queued for printing",
    job: buildJobResponse(job),
  });
}

async function handleJobLookup(req, res, jobId) {
  assertAuthorized(req);
  const job = jobs.get(jobId);
  if (!job) {
    throw new HttpError(404, "Job not found");
  }

  sendJson(res, 200, {
    ok: true,
    job: buildJobResponse(job),
  });
}

async function handleStats(req, res, url) {
  assertAuthorized(req);
  const limit = Number(url.searchParams.get("limit") || STATS_RECENT_LIMIT);
  sendJson(res, 200, {
    ok: true,
    stats: getStats(Number.isInteger(limit) && limit > 0 ? limit : STATS_RECENT_LIMIT),
  });
}

async function handleUiState(res) {
  sendJson(res, 200, {
    ok: true,
    state: await buildUiState(),
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      const resolvedPrinter = await getResolvedDefaultPrinter();
      sendJson(res, 200, {
        ok: true,
        host: HOST,
        port: PORT,
        printerHint: PRINTER_HINT,
        defaultPrinter: resolvedPrinter,
        defaultMedia: DEFAULT_MEDIA,
        authEnabled: Boolean(AUTH_TOKEN),
        dbBackend: DB_BACKEND,
        dbPath: DB_PATH,
        queue: {
          activeJobId,
          queued: queuedJobIds.length,
          knownJobs: jobs.size,
        },
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/printers") {
      assertAuthorized(req);
      const resolvedPrinter = await getResolvedDefaultPrinter();
      sendJson(res, 200, {
        ok: true,
        printerHint: PRINTER_HINT,
        defaultPrinter: resolvedPrinter,
        printers: await listPrinters(),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/stats") {
      await handleStats(req, res, url);
      return;
    }

    if (req.method === "GET" && url.pathname === "/ui/state") {
      await handleUiState(res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/ui/preview/current") {
      await servePreviewFile(res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/print") {
      await handlePrint(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/jobs/")) {
      const jobId = decodeURIComponent(url.pathname.slice("/jobs/".length));
      await handleJobLookup(req, res, jobId);
      return;
    }

    if (
      req.method === "GET" &&
      (url.pathname === "/" ||
        url.pathname.startsWith("/assets/") ||
        /\.(?:css|html|js|json|png|svg|webp)$/i.test(url.pathname))
    ) {
      await servePublicFile(res, url.pathname);
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    sendJson(res, statusCode, {
      ok: false,
      error: error.message,
    });
  }
});

async function main() {
  await initDatabase();
  await restoreJobsFromDatabase();
  server.listen(PORT, HOST, () => {
    console.log(
      `dnp-print-bridge listening on http://${HOST}:${PORT} using printer hint "${PRINTER_HINT}"`
    );
    console.log(`${DB_BACKEND} database: ${DB_PATH}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
