#!/usr/bin/env node

const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");

const HOST = process.env.TEST_PAGE_HOST || "127.0.0.1";
const PORT = Number(process.env.TEST_PAGE_PORT || 3460);
const MAX_BODY_BYTES = Number(
  process.env.TEST_PAGE_MAX_BODY_BYTES || 40 * 1024 * 1024
);
const FETCH_TIMEOUT_MS = Number(
  process.env.TEST_PAGE_FETCH_TIMEOUT_MS || 30000
);
const STATIC_ROOT = path.join(__dirname, "test-page");

const FILE_CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".webp": "image/webp",
};

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function contentTypeForFilePath(filePath) {
  return (
    FILE_CONTENT_TYPES[path.extname(String(filePath || "")).toLowerCase()] ||
    "application/octet-stream"
  );
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

function normalizeBridgeBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    throw new HttpError(400, "Target Tailscale IP or bridge URL is required");
  }

  let url;
  if (/^https?:\/\//i.test(raw)) {
    url = new URL(raw);
  } else if (/^[a-z0-9_.:-]+$/i.test(raw)) {
    url = new URL(`http://${raw}`);
  } else {
    throw new HttpError(
      400,
      "Target must be a Tailscale IP, hostname, host:port, or full http(s) URL"
    );
  }

  if (!url.port) {
    url.port = "3456";
  }

  url.pathname = "";
  url.search = "";
  url.hash = "";

  return url.toString().replace(/\/$/, "");
}

function buildRemoteHeaders(authToken, extraHeaders = {}) {
  const headers = {
    Accept: "application/json",
    ...extraHeaders,
  };

  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  return headers;
}

async function fetchRemoteJson(targetBaseUrl, pathname, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(`${targetBaseUrl}${pathname}`, {
      ...options,
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;

    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }
    }

    if (!response.ok) {
      throw new HttpError(
        response.status,
        payload?.error || `Remote request failed with HTTP ${response.status}`
      );
    }

    return {
      ok: true,
      status: response.status,
      payload,
    };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new HttpError(504, `Remote request timed out after ${FETCH_TIMEOUT_MS}ms`);
    }

    if (error instanceof HttpError) {
      throw error;
    }

    throw new HttpError(502, error.message || "Remote request failed");
  } finally {
    clearTimeout(timer);
  }
}

async function probeRemote(targetBaseUrl, authToken, pathname) {
  try {
    const result = await fetchRemoteJson(targetBaseUrl, pathname, {
      headers: buildRemoteHeaders(authToken),
    });
    return {
      ok: true,
      status: result.status,
      pathname,
      payload: result.payload,
    };
  } catch (error) {
    return {
      ok: false,
      status: error.statusCode || 502,
      pathname,
      error: error.message,
    };
  }
}

async function handleInspect(req, res) {
  const body = await readJsonBody(req);
  const targetBaseUrl = normalizeBridgeBaseUrl(body.target);
  const authToken = String(body.authToken || "").trim();

  const [health, uiState, stats, printers] = await Promise.all([
    probeRemote(targetBaseUrl, authToken, "/health"),
    probeRemote(targetBaseUrl, authToken, "/ui/state"),
    probeRemote(targetBaseUrl, authToken, "/stats?limit=10"),
    probeRemote(targetBaseUrl, authToken, "/printers"),
  ]);

  sendJson(res, 200, {
    ok: true,
    inspectedAt: new Date().toISOString(),
    target: targetBaseUrl,
    probes: {
      health,
      uiState,
      stats,
      printers,
    },
  });
}

async function handlePrint(req, res) {
  const body = await readJsonBody(req);
  const targetBaseUrl = normalizeBridgeBaseUrl(body.target);
  const authToken = String(body.authToken || "").trim();
  const jobName = String(body.jobName || "").trim();
  const dataUrl = String(body.dataUrl || "").trim();
  const copies = Number(body.copies || 1);

  if (!jobName) {
    throw new HttpError(400, "jobName is required");
  }

  if (!dataUrl) {
    throw new HttpError(400, "dataUrl is required");
  }

  if (!Number.isInteger(copies) || copies < 1 || copies > 99) {
    throw new HttpError(400, "copies must be an integer between 1 and 99");
  }

  const remoteBody = {
    dataUrl,
    jobName,
    copies,
  };

  const size = String(body.size || "").trim();
  const printer = String(body.printer || "").trim();

  if (size) {
    remoteBody.size = size;
  }

  if (printer) {
    remoteBody.printer = printer;
  }

  const result = await fetchRemoteJson(targetBaseUrl, "/print", {
    method: "POST",
    headers: buildRemoteHeaders(authToken, {
      "Content-Type": "application/json",
    }),
    body: JSON.stringify(remoteBody),
  });

  sendJson(res, 202, {
    ok: true,
    target: targetBaseUrl,
    forwardedAt: new Date().toISOString(),
    remote: result.payload,
  });
}

async function handleJob(req, res) {
  const body = await readJsonBody(req);
  const targetBaseUrl = normalizeBridgeBaseUrl(body.target);
  const authToken = String(body.authToken || "").trim();
  const jobId = encodeURIComponent(String(body.jobId || "").trim());

  if (!jobId) {
    throw new HttpError(400, "jobId is required");
  }

  const result = await fetchRemoteJson(targetBaseUrl, `/jobs/${jobId}`, {
    headers: buildRemoteHeaders(authToken),
  });

  sendJson(res, 200, {
    ok: true,
    target: targetBaseUrl,
    polledAt: new Date().toISOString(),
    remote: result.payload,
  });
}

function resolveStaticPath(urlPathname) {
  const relativePath =
    urlPathname === "/" ? "index.html" : decodeURIComponent(urlPathname.replace(/^\/+/, ""));
  const absolutePath = path.resolve(STATIC_ROOT, relativePath);

  if (
    !absolutePath.startsWith(`${STATIC_ROOT}${path.sep}`) &&
    absolutePath !== path.join(STATIC_ROOT, "index.html")
  ) {
    throw new HttpError(403, "Forbidden");
  }

  return absolutePath;
}

async function serveStatic(res, urlPathname) {
  const filePath = resolveStaticPath(urlPathname);
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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        name: "dnp-print-bridge-test-page",
        host: HOST,
        port: PORT,
        maxBodyBytes: MAX_BODY_BYTES,
        fetchTimeoutMs: FETCH_TIMEOUT_MS,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/inspect") {
      await handleInspect(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/print") {
      await handlePrint(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/job") {
      await handleJob(req, res);
      return;
    }

    if (
      req.method === "GET" &&
      (url.pathname === "/" ||
        /\.(?:css|html|js|json|png|svg|webp)$/i.test(url.pathname))
    ) {
      await serveStatic(res, url.pathname);
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    sendJson(res, error.statusCode || 500, {
      ok: false,
      error: error.message || "Internal server error",
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`test page listening on http://${HOST}:${PORT}`);
});
