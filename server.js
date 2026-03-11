#!/usr/bin/env node

const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3456);
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";
const DEFAULT_PRINTER =
  process.env.PRINTER_NAME || "Dai_Nippon_Printing_DS_RX1";
const DEFAULT_MEDIA = process.env.DEFAULT_MEDIA || "";
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 25 * 1024 * 1024);
const TMP_ROOT = process.env.TMPDIR || os.tmpdir();

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

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
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
      throw new Error(`Request body exceeded ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function assertAuthorized(req) {
  if (!AUTH_TOKEN) {
    return;
  }

  const header = req.headers.authorization || "";
  const expected = `Bearer ${AUTH_TOKEN}`;
  if (header !== expected) {
    const error = new Error("Unauthorized");
    error.statusCode = 401;
    throw error;
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

async function writePrintFile(payload) {
  const tempDir = await fs.mkdtemp(path.join(TMP_ROOT, "dnp-print-"));
  const jobName = sanitizeJobName(payload.jobName);
  const parsedBase64 = normalizeBase64(payload.data || payload.dataUrl);
  const contentType = payload.contentType || parsedBase64.contentType;
  const extension = extensionForMime(contentType);
  const filePath = path.join(tempDir, `${jobName}-${randomUUID()}${extension}`);

  if (payload.data || payload.dataUrl) {
    await fs.writeFile(filePath, Buffer.from(parsedBase64.data, "base64"));
    return filePath;
  }

  if (payload.url) {
    const response = await fetch(payload.url);
    if (!response.ok) {
      throw new Error(`Fetch failed with HTTP ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    await fs.writeFile(filePath, Buffer.from(arrayBuffer));
    return filePath;
  }

  if (payload.filePath) {
    return String(payload.filePath);
  }

  throw new Error("Provide one of: data, dataUrl, url, or filePath");
}

function buildLpArgs(payload, filePath) {
  const printer = payload.printer || DEFAULT_PRINTER;
  if (!printer) {
    throw new Error("No printer specified and PRINTER_NAME is not set");
  }

  const args = ["-d", printer];
  const jobName = sanitizeJobName(payload.jobName);
  args.push("-t", jobName);

  const copies = Number(payload.copies || 1);
  if (!Number.isInteger(copies) || copies < 1 || copies > 99) {
    throw new Error("copies must be an integer between 1 and 99");
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
  return { printer, args };
}

async function listPrinters() {
  const result = await spawnAndCollect("lpstat", ["-p"]);
  if (result.code !== 0) {
    throw new Error(result.stderr || "lpstat -p failed");
  }

  const printers = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^printer\s+(\S+)\s+is\s+(.+)$/);
      if (!match) {
        return { raw: line };
      }
      return {
        name: match[1],
        status: match[2],
      };
    });

  return printers;
}

async function handlePrint(req, res) {
  assertAuthorized(req);
  const payload = await readJsonBody(req);
  const filePath = await writePrintFile(payload);
  let result;

  try {
    const { printer, args } = buildLpArgs(payload, filePath);
    result = await spawnAndCollect("lp", args);

    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || "lp failed");
    }

    sendJson(res, 200, {
      ok: true,
      printer,
      command: ["lp", ...args.slice(0, -1), "<temp-file>"],
      lpOutput: result.stdout,
      sourceFile: filePath,
    });
  } finally {
    if (result && result.code === 0 && filePath.startsWith(TMP_ROOT)) {
      fs.rm(path.dirname(filePath), { recursive: true, force: true }).catch(
        () => {}
      );
    }
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, {
        ok: true,
        host: HOST,
        port: PORT,
        defaultPrinter: DEFAULT_PRINTER,
        defaultMedia: DEFAULT_MEDIA,
        authEnabled: Boolean(AUTH_TOKEN),
      });
      return;
    }

    if (req.method === "GET" && req.url === "/printers") {
      assertAuthorized(req);
      sendJson(res, 200, {
        ok: true,
        defaultPrinter: DEFAULT_PRINTER,
        printers: await listPrinters(),
      });
      return;
    }

    if (req.method === "POST" && req.url === "/print") {
      await handlePrint(req, res);
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

server.listen(PORT, HOST, () => {
  console.log(
    `dnp-print-bridge listening on http://${HOST}:${PORT} using printer "${DEFAULT_PRINTER}"`
  );
});
