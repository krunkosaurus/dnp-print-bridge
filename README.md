# DNP Print Bridge

Small Node.js HTTP service for printing to a DNP printer through a local CUPS queue from your own code.

It was written and tested for:

- `DNP DS-RX1`
- `DNP DS-RX1HS`

The goal is simple:

- let your app send an HTTP request
- queue the print job automatically
- print jobs one after another in order
- do it without showing the normal macOS print dialog

In plain terms, this is a small local print server for a machine that has the printer attached through CUPS. Your other apps can call it to queue photo prints automatically and quietly in the background.

The same service can also host a fullscreen diagnostics UI for a Raspberry Pi kiosk display. That UI shows:

- bridge online status
- Tailscale IPv4 address
- jobs printed today
- current printer queue status
- a 10 second preview of the most recent image print job before returning to `READY`

The queue is persisted locally so the bridge can recover job history and in-flight jobs after a restart or crash. On newer Node.js versions it uses SQLite; on older environments without `node:sqlite` it falls back to a JSON file.

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
DB_BACKEND=sqlite
DB_PATH=/path/to/dnp-print-bridge.sqlite
UI_PREVIEW_MS=10000
node server.js
```

Notes:

- The default bind host is `0.0.0.0`, so other machines on the network can call the bridge.
- Set `HOST=127.0.0.1` if only the local Mac should call it.
- Use `AUTH_TOKEN` if anything outside the local machine will call it.
- `PRINTER_NAME` is optional and acts as a hint. The bridge will try to pick an enabled matching queue such as `Dai_Nippon_Printing_DS_RX1_2` when the exact base queue is disabled.
- For the RX1HS, the requested output size still has to match the loaded media pack.
- The bridge accepts either friendly sizes like `6x4` or raw CUPS media values like `300dnp6x4`.
- By default the SQLite database is stored at `./data/dnp-print-bridge.sqlite`.
- `DB_BACKEND` defaults to `sqlite` when `node:sqlite` is available, otherwise it falls back to `json`.
- If you use `DB_BACKEND=json`, set `DB_PATH` to a `.json` file path for clarity.
- The diagnostics UI is served from `/`.
- The diagnostics JSON state is available from `GET /ui/state`.

Submit the included sample image after the bridge is running:

```bash
npm run sample
```

## Test Page

For browser-based integration testing against a bridge reachable over Tailscale,
start the standalone test harness:

```bash
npm run test-page
```

By default it serves:

```bash
http://127.0.0.1:3460
```

You can override the bind host or port:

```bash
TEST_PAGE_HOST=0.0.0.0
TEST_PAGE_PORT=3460
npm run test-page
```

The page lets you:

- enter a Tailscale IP, hostname, `host:port`, or full bridge URL
- add an optional bridge `AUTH_TOKEN`
- drag and drop any image file for submission
- override `size`, `copies`, and `printer`
- inspect live data from the remote bridge through `/health`, `/ui/state`, `/stats`, `/printers`, and `/jobs/:id`

Examples of valid targets:

- `100.64.0.12`
- `100.64.0.12:3456`
- `printer-node.ts.net`
- `http://100.64.0.12:3456`

## Raspberry Pi Deployment

For older Raspberry Pi hardware that cannot run a recent enough Node.js build for `node:sqlite`, this bridge can run with:

- `Node.js 18`
- `DB_BACKEND=json`
- Gutenprint / CUPS queue `DNP_DSRX1`

The bridge systemd unit is included at `deploy/systemd/dnp-print-bridge.service`.
The test page systemd unit is included at
`deploy/systemd/dnp-print-bridge-test-page.service`.

For a modern Raspberry Pi with a local screen, the kiosk unit is included at:

- `deploy/systemd/dnp-print-bridge-kiosk.service`
- `deploy/scripts/start-kiosk.sh`
- `deploy/scripts/configure-raspberry-pi.sh`

The steps below match the setup that was verified on an older ARMv6 Raspberry Pi with a `DNP DS-RX1` attached over USB.

### 1. Install system packages

```bash
sudo apt-get update
sudo apt-get -y full-upgrade
sudo apt-get -y install git curl ca-certificates xz-utils cups cups-bsd printer-driver-gutenprint
```

### 2. Confirm the printer is visible over USB

```bash
lsusb
dmesg | egrep -i 'usblp|dnp|citizen|printer'
```

Expected USB identity for this setup looked like:

- `Citizen Systems CY / DNP DSRX1`

### 3. Install a Node.js build that works on older ARMv6 Pis

The stock or NodeSource build on older Pis may fail with `Illegal instruction`. This ARMv6 build was verified:

```bash
NODE_VERSION=v18.20.8
cd /tmp
curl -fsSLO https://unofficial-builds.nodejs.org/download/release/${NODE_VERSION}/node-${NODE_VERSION}-linux-armv6l.tar.xz
sudo mkdir -p /opt/node-${NODE_VERSION}
sudo tar -xJf node-${NODE_VERSION}-linux-armv6l.tar.xz -C /opt/node-${NODE_VERSION} --strip-components=1
sudo ln -sfn /opt/node-${NODE_VERSION}/bin/node /usr/local/bin/node
sudo ln -sfn /opt/node-${NODE_VERSION}/bin/npm /usr/local/bin/npm
sudo ln -sfn /opt/node-${NODE_VERSION}/bin/npx /usr/local/bin/npx
node -v
npm -v
```

### 4. Copy the repo onto the Pi

```bash
cd /home/pi
git clone YOUR_REPO_URL dnp-print-bridge
cd dnp-print-bridge
```

Or copy it from another machine with `rsync`.

### 5. Create the CUPS queue

Find the printer backend URI:

```bash
/usr/sbin/lpinfo -v
```

For the verified setup, the printer URI was:

```bash
gutenprint53+usb://dnp-dsrx1/CB2D5B205630
```

Create the queue:

```bash
sudo /usr/sbin/lpadmin -x DNP_DSRX1 2>/dev/null || true
sudo /usr/sbin/lpadmin \
  -p DNP_DSRX1 \
  -E \
  -v "gutenprint53+usb://dnp-dsrx1/CB2D5B205630" \
  -m "gutenprint.5.3://dnp-dsrx1/expert"
sudo lpadmin -d DNP_DSRX1
```

Check the queue:

```bash
lpstat -t
lpoptions -p DNP_DSRX1 -l | grep '^PageSize/'
```

On the verified Pi, Gutenprint exposed `PageSize` values such as:

- `w288h432` for `6x4`
- `w360h504` for `5x7`
- `w432h576` for `6x8`

The bridge now maps friendly sizes like `6x4` to those Gutenprint `PageSize` values automatically when needed.

### 6. Install the bridge service

From the repo root:

```bash
sudo cp deploy/systemd/dnp-print-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dnp-print-bridge
```

### 7. Optional: install the test page on port 80

If you want the standalone browser test harness to be reachable on port `80` and
start on boot:

```bash
sudo cp deploy/systemd/dnp-print-bridge-test-page.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dnp-print-bridge-test-page
```

Check service state:

```bash
systemctl status dnp-print-bridge --no-pager
curl http://127.0.0.1:3456/health
curl http://127.0.0.1:3456/printers
```

### 7. Optional kiosk setup for a Raspberry Pi display

If the Pi already boots into another local webpage, the included helper script can disable the old PM2/nginx/chromium startup path, create the DNP queue if it is missing, and enable both the bridge and kiosk services:

```bash
cd /home/pi/dnp-print-bridge
chmod +x deploy/scripts/configure-raspberry-pi.sh
sudo ./deploy/scripts/configure-raspberry-pi.sh
```

This expects:

- user `pi`
- an autologin desktop session with X on `:0`
- Chromium installed as `chromium-browser`
- Gutenprint model `gutenprint.5.3://dnp-dsrx1/expert`

After it finishes, Chromium should reopen in kiosk mode on:

```bash
http://127.0.0.1:3456/
```

Useful checks:

```bash
systemctl status dnp-print-bridge --no-pager
systemctl status dnp-print-bridge-kiosk --no-pager
curl http://127.0.0.1:3456/ui/state
```

### 8. Optional real print test

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

Or submit a request directly:

```bash
curl \
  -X POST http://127.0.0.1:3456/print \
  -H 'Content-Type: application/json' \
  -d '{
    "filePath": "/home/pi/dnp-print-bridge/sample.jpeg",
    "jobName": "pi-sample-6x4",
    "size": "6x4",
    "copies": 1,
    "printer": "DNP_DSRX1"
  }'
```

## What Was Tested

The following end-to-end flow was tested successfully:

- source file: `sample.jpeg`
- requested size: `6x4`
- mapped CUPS media: `300dnp6x4`
- printer type: `DNP DS-RX1 / DS-RX1HS`

The project was tested with a real DNP queue on macOS and accepted by CUPS.

This does not mean every DNP model or every macOS or Linux printer driver variant will behave identically. You should verify the media names exposed by your own queue with:

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

Because jobs are stored persistently, the bridge can also:

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
