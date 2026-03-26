# DNP Print Bridge

Small Node.js HTTP service for printing to a DNP printer on macOS from your own code.

It was written and tested for:

- `DNP DS-RX1`
- `DNP DS-RX1HS`

The goal is simple:

- let your app send an HTTP request
- queue the print job automatically
- print jobs one after another in order
- do it without showing the normal macOS print dialog

In plain terms, this is a small local print server for your Mac. Your other apps can call it to queue photo prints automatically and quietly in the background.

The queue is persisted in SQLite, so the bridge can recover job history and in-flight jobs after a restart or crash.

## Run

```bash
cd /path/to/dnp-print-bridge
node server.js
```

Optional environment variables:

```bash
HOST=0.0.0.0
PORT=3456
PRINTER_NAME=Your_Printer_Queue_Name_Or_Prefix
DEFAULT_MEDIA=4x6
AUTH_TOKEN=replace-me
DB_PATH=/path/to/dnp-print-bridge.sqlite
node server.js
```

Notes:

- Keep `HOST=127.0.0.1` if only the local Mac should call it.
- Use `HOST=0.0.0.0` plus `AUTH_TOKEN` if your Android tablet will call it over LAN.
- `PRINTER_NAME` is optional and acts as a hint. The bridge will try to pick an enabled matching queue such as `Dai_Nippon_Printing_DS_RX1_2` when the exact base queue is disabled.
- For the RX1HS, the requested output size still has to match the loaded media pack.
- The bridge accepts either friendly sizes like `6x4` or raw CUPS media values like `300dnp6x4`.
- By default the SQLite database is stored at `./data/dnp-print-bridge.sqlite`.
- This project uses Node's built-in `node:sqlite`, which is currently marked experimental by Node.

Submit the included sample image after the bridge is running:

```bash
npm run sample
```

This sends a real print job to the selected printer.

Useful overrides:

```bash
BRIDGE_URL=http://127.0.0.1:3456
PRINTER_NAME=Your_Printer_Queue_Name
SAMPLE_FILE=/absolute/path/to/sample.jpeg
SAMPLE_SIZE=6x4
SAMPLE_COPIES=1
AUTH_TOKEN=replace-me
npm run sample
```

## What Was Tested

The following end-to-end flow was tested successfully:

- source file: `sample.jpeg`
- requested size: `6x4`
- mapped CUPS media: `300dnp6x4`
- printer type: `DNP DS-RX1 / DS-RX1HS`

The project was tested with a real DNP queue on macOS and accepted by CUPS.

This does not mean every DNP model or every macOS printer driver variant will behave identically. You should verify the media names exposed by your own queue with:

```bash
lpoptions -p YOUR_PRINTER_QUEUE -l
```

You can list your available printer queues with:

```bash
lpstat -p
```

## How it works

1. Your app `POST`s a print request to this server.
2. The server returns its own job id immediately.
3. Jobs are processed one at a time.
4. The server submits the active job to macOS CUPS.
5. The next queued job starts only after the current CUPS job finishes.
6. Your app can poll `GET /jobs/:id` to see:
   - current status
   - the underlying CUPS request id, when available
   - how many jobs are still ahead of it

This makes it suitable for photobooth flows where multiple users may print one after another and you want your app to know where each print is in line.

Because jobs are stored in SQLite, the bridge can also:

- keep a history of completed and failed jobs
- retain job timestamps
- recover its queue state after restart

## Endpoints

### `GET /health`

```bash
curl http://127.0.0.1:3456/health
```

Example response fields:

- `defaultPrinter`
- `dbPath`
- `queue.activeJobId`
- `queue.queued`
- `queue.knownJobs`

### `GET /printers`

```bash
curl -H "Authorization: Bearer replace-me" http://127.0.0.1:3456/printers
```

Skip the auth header if `AUTH_TOKEN` is unset.

### `GET /jobs/:id`

Look up a queued or active job by id.

```bash
curl http://127.0.0.1:3456/jobs/YOUR_JOB_ID
```

Example response fields:

- `status`
- `jobsAhead`
- `cupsRequestId`
- `createdAt`
- `startedAt`
- `completedAt`
- `error`

### `GET /stats`

Get persisted queue and history statistics.

```bash
curl http://127.0.0.1:3456/stats
```

Optional query parameter:

- `limit`: number of recent jobs to include

```bash
curl http://127.0.0.1:3456/stats?limit=10
```

Example response fields:

- `totalJobs`
- `completedJobs`
- `failedJobs`
- `openJobs`
- `activeJobId`
- `queuedJobs`
- `recentJobs`

### `POST /print`

JSON body fields:

- `printer`: optional printer queue name
- `jobName`: optional job title
- `copies`: optional integer, defaults to `1`
- `media` or `size`: optional friendly size or raw CUPS media value
- `options`: optional object of extra CUPS `-o` options
- one of:
  - `data`: base64 payload or `data:` URL
  - `url`: remote file URL
  - `filePath`: local file path already on the Mac

`POST /print` returns `202 Accepted` with a bridge job object. It does not wait for the print to fully finish before replying.

### Friendly size mapping

Friendly sizes currently mapped for the tested RX1 / RX1HS queue:

- `4x6` or `6x4` -> `300dnp6x4`
- `5x7` -> `210dnp5x7`
- `6x8` or `8x6` -> `310dnp6x8`
- `5x5` -> `dnp5x5`
- `6x6` -> `dnp6x6`
- `3.5x5` or `5x3.5` -> `200dnp5x3.5`

These came from the tested queue’s `lpoptions -l` output. Depending on your installed DNP driver and printer model, your queue may expose slightly different names.

### Practical RX1HS note

Even though the printer uses roll media, the driver does not accept arbitrary page sizes. The requested size must match a supported media and cut combination for the loaded pack.

Examples:

- `6x4` or `4x6`
- `5x7`
- `6x8`
- `5x5`
- `6x6`

Print a local file:

```bash
curl \
  -X POST http://127.0.0.1:3456/print \
  -H 'Content-Type: application/json' \
  -d '{
    "filePath": "/absolute/path/to/test.jpg",
    "jobName": "booth-test",
    "size": "6x4",
    "copies": 1
  }'
```

Typical response:

```json
{
  "ok": true,
  "message": "Job accepted and queued for printing",
  "job": {
    "id": "a-bridge-job-id",
    "status": "queued",
    "printer": "Your_Printer_Queue_Name",
    "jobName": "booth-test",
    "copies": 1,
    "size": "6x4",
    "media": "300dnp6x4",
    "jobsAhead": 0,
    "cupsRequestId": null,
    "createdAt": "2026-03-12T10:00:00.000Z",
    "startedAt": null,
    "completedAt": null,
    "error": null
  }
}
```

Print the included sample file as a `6x4`:

```bash
curl \
  -X POST http://127.0.0.1:3456/print \
  -H 'Content-Type: application/json' \
  -d '{
    "filePath": "/absolute/path/to/dnp-print-bridge/sample.jpeg",
    "jobName": "sample-6x4",
    "size": "6x4",
    "options": {
      "fit-to-page": "true"
    }
  }'
```

Print from a URL:

```bash
curl \
  -X POST http://127.0.0.1:3456/print \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer replace-me' \
  -d '{
    "url": "https://example.com/print.jpg",
    "jobName": "session-123",
    "media": "4x6",
    "options": {
      "fit-to-page": "true"
    }
  }'
```

Print from base64:

```bash
curl \
  -X POST http://127.0.0.1:3456/print \
  -H 'Content-Type: application/json' \
  -d '{
    "data": "data:image/jpeg;base64,/9j/4AAQSk...",
    "jobName": "session-124",
    "media": "4x6"
  }'
```

## Android app call

Your Android tablet can `POST` to the Mac over LAN:

```http
POST http://MAC-IP:3456/print
Authorization: Bearer replace-me
Content-Type: application/json
```

```json
{
  "url": "https://your-booth-app.local/print/final/abc123.jpg",
  "jobName": "abc123",
  "size": "6x4",
  "copies": 1
}
```

Then your app can poll the returned job id:

```http
GET http://MAC-IP:3456/jobs/JOB_ID
Authorization: Bearer replace-me
```

The returned `jobsAhead` value tells you how many prints are still in front of this one.

If you want overall counts and recent timestamps, call:

```http
GET http://MAC-IP:3456/stats
Authorization: Bearer replace-me
```

Recommended deployment for Android:

- run this service on the Mac connected by USB to the RX1HS
- start it with `HOST=0.0.0.0`
- set `AUTH_TOKEN`
- have the tablet call the Mac over local Wi-Fi or wired LAN

Example:

```bash
cd /path/to/dnp-print-bridge
HOST=0.0.0.0 AUTH_TOKEN=replace-me node server.js
```

Then from the Android app:

```http
POST http://192.168.1.50:3456/print
Authorization: Bearer replace-me
Content-Type: application/json
```

```json
{
  "url": "https://your-app/print/session-123.jpg",
  "jobName": "session-123",
  "size": "6x4",
  "copies": 1,
  "options": {
    "fit-to-page": "true"
  }
}
```

Then poll:

```bash
curl \
  -H 'Authorization: Bearer replace-me' \
  http://192.168.1.50:3456/jobs/JOB_ID
```

And check persisted history/stats:

```bash
curl \
  -H 'Authorization: Bearer replace-me' \
  http://192.168.1.50:3456/stats
```
