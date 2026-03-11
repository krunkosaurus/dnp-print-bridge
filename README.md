# DNP Print Bridge

Small Node.js HTTP service for silent printing to a macOS CUPS printer queue.

This project was built and tested against your current Mac printer queue:

- `Dai_Nippon_Printing_DS_RX1`

It accepts simple HTTP requests and prints directly through macOS `lp`, without opening a print dialog.

## Run

```bash
cd /Users/krunkosaurus/repos/dnp-print-bridge
node server.js
```

Optional environment variables:

```bash
HOST=0.0.0.0
PORT=3456
PRINTER_NAME=Dai_Nippon_Printing_DS_RX1
DEFAULT_MEDIA=4x6
AUTH_TOKEN=replace-me
node server.js
```

Notes:

- Keep `HOST=127.0.0.1` if only the local Mac should call it.
- Use `HOST=0.0.0.0` plus `AUTH_TOKEN` if your Android tablet will call it over LAN.
- For the RX1HS, the requested output size still has to match the loaded media pack.
- The bridge accepts either friendly sizes like `6x4` or raw CUPS media values like `300dnp6x4`.

## What Was Tested

The following end-to-end test succeeded on this Mac:

- source file: `/Users/krunkosaurus/repos/dnp-print-bridge/sample.jpeg`
- requested size: `6x4`
- mapped CUPS media: `300dnp6x4`
- printer queue: `Dai_Nippon_Printing_DS_RX1`

Accepted CUPS jobs during testing:

- `Dai_Nippon_Printing_DS_RX1-82`
- `Dai_Nippon_Printing_DS_RX1-83`

## Endpoints

### `GET /health`

```bash
curl http://127.0.0.1:3456/health
```

### `GET /printers`

```bash
curl -H "Authorization: Bearer replace-me" http://127.0.0.1:3456/printers
```

Skip the auth header if `AUTH_TOKEN` is unset.

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

### Friendly size mapping

Friendly sizes currently mapped for your RX1 queue:

- `4x6` or `6x4` -> `300dnp6x4`
- `5x7` -> `210dnp5x7`
- `6x8` or `8x6` -> `310dnp6x8`
- `5x5` -> `dnp5x5`
- `6x6` -> `dnp6x6`
- `3.5x5` or `5x3.5` -> `200dnp5x3.5`

These came from the queue’s current `lpoptions -l` output, so they match the installed DNP driver on this Mac.

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
    "filePath": "/Users/krunkosaurus/Desktop/test.jpg",
    "jobName": "booth-test",
    "size": "6x4",
    "copies": 1
  }'
```

Print the included sample file as a `6x4`:

```bash
curl \
  -X POST http://127.0.0.1:3456/print \
  -H 'Content-Type: application/json' \
  -d '{
    "filePath": "/Users/krunkosaurus/repos/dnp-print-bridge/sample.jpeg",
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

Recommended deployment for Android:

- run this service on the Mac connected by USB to the RX1HS
- start it with `HOST=0.0.0.0`
- set `AUTH_TOKEN`
- have the tablet call the Mac over local Wi-Fi or wired LAN

Example:

```bash
cd /Users/krunkosaurus/repos/dnp-print-bridge
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
