#!/usr/bin/env node

const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3456);
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";
const PRINTER_HINT =
  process.env.PRINTER_NAME || "Dai_Nippon_Printing_DS_RX1";
const DEFAULT_MEDIA = process.env.DEFAULT_MEDIA || "";
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 25 * 1024 * 1024);
const TMP_ROOT = process.env.TMPDIR || os.tmpdir();
const JOB_POLL_MS = Number(process.env.JOB_POLL_MS || 2000);
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 20 * 60 * 1000);
const DB_PATH =
  process.env.DB_PATH ||
  path.join(__dirname, "data", "dnp-print-bridge.sqlite");
const STATS_RECENT_LIMIT = Number(process.env.STATS_RECENT_LIMIT || 20);

const MIME_EXTENSIONS = {
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
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

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

let db;
let nextQueueOrder = 1;
const jobs = new Map();
const queuedJobIds = [];
let activeJobId = null;
let queueWorkerRunning = false;

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

function spawnAndCollect(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
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

async function initDatabase() {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(`
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

  const row = db
    .prepare("SELECT COALESCE(MAX(queue_order), 0) + 1 AS next_queue_order FROM jobs")
    .get();
  nextQueueOrder = Number(row.next_queue_order || 1);
}

function persistJob(job) {
  db.prepare(
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
  ).run({
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
  const media = normalizeFriendlyMedia(
    payload.media || payload.size || DEFAULT_MEDIA
  );
  if (media) {
    options.media = media;
  }

  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    args.push("-o", `${key}=${value}`);
  }

  args.push(filePath);
  return { printer, args, media, jobName, copies };
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

  const rows = db
    .prepare("SELECT * FROM jobs ORDER BY queue_order ASC, created_at ASC")
    .all();
  const outstandingCache = new Map();

  async function getOutstanding(printer) {
    if (!outstandingCache.has(printer)) {
      outstandingCache.set(printer, await listOutstandingCupsJobs(printer));
    }
    return outstandingCache.get(printer);
  }

  for (const row of rows) {
    const job = hydrateJob(row);
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
  const totals = db
    .prepare(
      `
        SELECT
          COUNT(*) AS total_jobs,
          COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_jobs,
          COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_jobs,
          COALESCE(SUM(CASE WHEN status IN ('queued', 'submitting', 'printing') THEN 1 ELSE 0 END), 0) AS open_jobs
        FROM jobs
      `
    )
    .get();

  const recentJobs = db
    .prepare(
      `
        SELECT
          id,
          status,
          printer,
          job_name,
          copies,
          requested_size,
          media,
          cups_request_id,
          created_at,
          started_at,
          completed_at,
          error
        FROM jobs
        ORDER BY queue_order DESC
        LIMIT ?
      `
    )
    .all(limit)
    .map(buildRecentJobResponse);

  return {
    dbPath: DB_PATH,
    totalJobs: Number(totals.total_jobs),
    completedJobs: Number(totals.completed_jobs),
    failedJobs: Number(totals.failed_jobs),
    openJobs: Number(totals.open_jobs),
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

    if (req.method === "POST" && url.pathname === "/print") {
      await handlePrint(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/jobs/")) {
      const jobId = decodeURIComponent(url.pathname.slice("/jobs/".length));
      await handleJobLookup(req, res, jobId);
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
    console.log(`sqlite database: ${DB_PATH}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
