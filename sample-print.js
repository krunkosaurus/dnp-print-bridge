#!/usr/bin/env node

const path = require("node:path");

const BRIDGE_URL = process.env.BRIDGE_URL || "http://127.0.0.1:3456";
const SAMPLE_FILE =
  process.env.SAMPLE_FILE || path.join(__dirname, "sample.jpeg");
const SAMPLE_SIZE = process.env.SAMPLE_SIZE || "6x4";
const SAMPLE_JOB_NAME = process.env.SAMPLE_JOB_NAME || "sample-6x4";
const SAMPLE_COPIES = Number(process.env.SAMPLE_COPIES || 1);
const SAMPLE_TIMEOUT_MS = Number(process.env.SAMPLE_TIMEOUT_MS || 120000);
const POLL_INTERVAL_MS = Number(process.env.SAMPLE_POLL_MS || 2000);
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";
const PRINTER_NAME = process.env.PRINTER_NAME || "";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildHeaders() {
  const headers = {
    "Content-Type": "application/json",
  };

  if (AUTH_TOKEN) {
    headers.Authorization = `Bearer ${AUTH_TOKEN}`;
  }

  return headers;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      payload?.error || `Request failed with HTTP ${response.status}`
    );
  }

  return payload;
}

async function submitSampleJob() {
  const body = {
    filePath: SAMPLE_FILE,
    jobName: SAMPLE_JOB_NAME,
    size: SAMPLE_SIZE,
    copies: SAMPLE_COPIES,
  };

  if (PRINTER_NAME) {
    body.printer = PRINTER_NAME;
  }

  return fetchJson(`${BRIDGE_URL}/print`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
}

async function waitForCompletion(jobId) {
  const deadline = Date.now() + SAMPLE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const payload = await fetchJson(`${BRIDGE_URL}/jobs/${jobId}`, {
      headers: buildHeaders(),
    });
    const job = payload.job;

    console.log(
      `[${new Date().toISOString()}] status=${job.status} jobsAhead=${job.jobsAhead} cupsRequestId=${job.cupsRequestId || "-"}`
    );

    if (job.status === "completed") {
      return job;
    }

    if (job.status === "failed") {
      throw new Error(job.error || "Print job failed");
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting ${SAMPLE_TIMEOUT_MS}ms for job ${jobId}`);
}

async function main() {
  if (!Number.isInteger(SAMPLE_COPIES) || SAMPLE_COPIES < 1) {
    throw new Error("SAMPLE_COPIES must be a positive integer");
  }

  const accepted = await submitSampleJob();
  const job = accepted.job;

  console.log(`Accepted bridge job ${job.id}`);
  console.log(`Printer: ${job.printer}`);
  console.log(`Media: ${job.media || "-"}`);
  console.log(`File: ${SAMPLE_FILE}`);

  const completedJob = await waitForCompletion(job.id);

  console.log(`Completed bridge job ${completedJob.id}`);
  console.log(`CUPS request: ${completedJob.cupsRequestId || "-"}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
