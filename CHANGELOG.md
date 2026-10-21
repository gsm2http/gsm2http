# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before `1.0.0`, any minor release may contain breaking changes.

## [0.1.0](https://github.com/gsm2http/gsm2http/compare/v0.1.0-alpha.0...v0.1.0) (2026-10-21)


### Added

* initial release of gsm2http ([d5966a8](https://github.com/gsm2http/gsm2http/commit/d5966a86349eac8c43523dd3447518b4c2f5a7f8))

## [Unreleased]

First public release of gsm2http, the open-source edition of a private USB-modem gateway.

### Added

- Receive SMS from USB GSM/3G/LTE modems, with GSM 7-bit and UCS-2 decoding and reassembly of multi-part messages.
- Incoming-call detection with caller ID.
- Call control: dial with a set duration (optionally waiting until the call ends), and hang up.
- Send SMS (`POST /api/modems/{modemId}/sms`), split into concatenated SMS-SUBMIT parts when the text does not fit in one.
- Modem drivers: vendor behaviour lives in `backend/src/modem/drivers` (generic 3GPP and Huawei), chosen per port by manufacturer, model or USB vendor ID, with a `MODEM_DRIVER` override. `GET /api/modems` reports each modem's `driver` and `capabilities`.
- SIM PIN unlock, diagnostics refresh, and network mode switching (2G / 3G / auto).
- Support for several modems at once: automatic discovery on `/dev/ttyUSB*` and `/dev/ttyACM*`, hot-plug, de-duplication by IMEI, and lookup by ID, port, IMEI, model or phone number.
- Event bus with a versioned envelope (`schemaVersion: 1`, unique `id`, `modem` with IMEI, `data`). Events: `sms.received`, `sms.sent`, `call.incoming`, `call.ended`, `modem.added`, `modem.removed`, `modem.status`. Socket.io, webhooks and MQTT all consume the same bus. Schema and versioning policy in `docs/events.md`.
- Pluggable notifiers: any number of webhook and MQTT sinks, each with its own event and modem filter, from env vars and/or a YAML file (`CONFIG_FILE`, see `config.example.yaml`) with `${VAR}` interpolation. Configuration mistakes fail at startup.
- Webhooks: several URLs (`WEBHOOK_URL` is comma-separated), retries with exponential backoff and jitter on timeouts, 408, 425, 429 and 5xx (honouring `Retry-After`), per-attempt timeout, `X-Gsm2http-Event`/`-Delivery`/`-Attempt` headers, and HMAC-SHA256 signatures with a timestamp (`WEBHOOK_SECRET`).
- MQTT sink: topics `gsm2http/<modemId>/<family>/<action>`, retained `modem/status`, `online`/`offline` availability with a last will, QoS 1, and optional Home Assistant MQTT discovery (signal, operator, SIM status, connectivity, SMS and call event entities per modem).
- `modem.status` is rate-limited per modem for webhooks and MQTT (`MODEM_STATUS_MIN_INTERVAL_MS`, latest state wins).
- `GET /api/notifiers`: configured sinks (URLs redacted), delivery statistics and the last 100 delivery attempts, without payloads. The web UI shows them in a *Notifiers* panel.
- `POST /api/modems/{id}/dial` returns a `callId` that matches the call's `call.ended` event.
- Recipes: n8n (with signature verification and replying through the API), Home Assistant (MQTT discovery and automations), Node-RED, and webhook receivers in Node.js, Python and curl.
- React web UI with live modem status, AT log, and test controls.
- Mock mode with two simulated modems that run the real driver and parser code over a fake serial port, and `/api/mock/sms` and `/api/mock/call` endpoints.
- Docker images for `linux/amd64`, `linux/arm64` and `linux/arm/v7`: an all-in-one image serving the API and UI on one port, plus separate API and nginx UI images. They run as a non-root user with a read-only root filesystem and a `/healthz` healthcheck. Bare-metal build and start scripts, a hardened systemd unit and udev rules.
- `GET /healthz` liveness endpoint, `HOST`, `SCAN_INTERVAL_MS` and `POLL_INTERVAL_MS` settings, and wildcard and `/dev/serial/by-id` paths in `MODEM_PORTS`.
- Documentation: README, OpenAPI 3.1 spec, events reference, recipes (n8n, Home Assistant, Node-RED, scripts), deployment guide, modem guide, FAQ.
- Apache-2.0 licence, NOTICE, Code of Conduct, security policy, contributing guide, and issue and PR templates.

### Security

- **Breaking:** `API_TOKEN` (at least 32 characters) is required. The REST API, the Socket.io stream (`auth: { token }`) and the web UI (sign-in screen, token kept in the browser) all use it, and gsm2http refuses to start without it unless `AUTH_DISABLED=true` is set explicitly. After 20 wrong tokens in 5 minutes, further wrong tokens from that address get 429 for the rest of the window; the correct token still works.
- **Breaking:** CORS is same-origin only. List extra browser origins in `CORS_ORIGINS`.
- AT command injection hardening: phone numbers, PINs, SMS text, mock PDUs and modem IDs are validated before they reach `ATD`, `AT+CPIN` or `AT+CMGS` (CR, LF, `;`, Ctrl-Z, ESC and other control characters are rejected), drivers check their inputs again, and the modem's command queue refuses any command line that isn't printable ASCII and any prompt payload that isn't hex.
- Per-modem rate limits on sending SMS (`SMS_MIN_INTERVAL_MS`, `SMS_DAILY_LIMIT`), dialling (`CALLS_HOURLY_LIMIT`) and SIM unlocking (`UNLOCK_HOURLY_LIMIT`), answered with 429 and `Retry-After`.
- SIM PIN guard: before unlocking, gsm2http reads the remaining PIN attempts (`AT+CPINR`, or `AT^CPIN?` on Huawei) and refuses with 409 when only one is left, so the API can never PUK-lock a SIM. If the modem can't report the count, one wrong PIN blocks further attempts until restart. Unlock requests for a modem run one at a time, so parallel requests can't get around the guard.
- Security headers via helmet (Content-Security-Policy, `X-Content-Type-Options`, frame protection and more; HSTS is left to the TLS proxy), a 32 KB JSON body limit (413), and error responses that never contain stack traces or parser internals.
- `.env.example` documents every setting.

### Changed since the prototype import

- **Breaking:** event payloads use the versioned envelope: fields moved under `data` and `modem` (`sender` → `data.sender`, `modemId` → `modem.id`, the SMS `timestamp` → `data.sentAt`); `callerId` is gone. A mapping table is in `docs/events.md#migrating-from-the-unversioned-payloads`. Socket.io's `modem.status` carries the envelope instead of the bare modem.
- **Breaking:** `call.incoming` is sent once per call instead of once per ring, and is followed by `call.ended`.
- **Breaking:** `POST /api/config/webhook` (changing the URL at runtime) is removed: on an unauthenticated API it let anyone redirect incoming SMS. `GET /api/config` returns `notifierCount` instead of `webhookUrl`/`webhookConfigured`.
- **Breaking:** events use their documented names. Webhook bodies carry `"event": "sms.received"` or `"call.incoming"` instead of `"type": "sms"`/`"call"`. Socket.io events are `modems.list`, `modem.status`, `sms.received`, `call.incoming` and `modem.raw`.
- **Breaking:** the single-modem routes `/api/modem/*` are gone; use `/api/modems/{modemId}/*`. The dial body is `{ to, durationMs | durationSeconds, sync, force }`: the `number`, `duration` and `waitForCompletion` aliases, query-string parameters and `from`/`modemId` body fields are no longer read. `MODEM_PORT` is no longer read; use `MODEM_PORTS`.
- **Breaking:** request bodies are validated. Numbers must be digits with an optional `+`, PINs 4–8 digits, network `type` one of `2g`, `3g`, `auto`; anything else is a 400 instead of being passed to the modem. Every error response is `{ "success": false, "error": "…" }`.
- `/api/mock/*` routes exist only in mock mode (404 otherwise), and their responses use `parts` and `injectedIndices`.
- `PORT` defaults to `9333`, and the server listens on `127.0.0.1` unless `HOST` says otherwise.
- An explicit `MODEM_PORTS` list is used exclusively, and `auto` probes only USB serial and CDC-ACM ports, never on-board UARTs. Ports that don't answer are not probed again until replugged or for 5 minutes.
- The fallback SIM storage sweep runs every 30 s instead of 5 s.
- Modem IDs are kept per IMEI, so a replugged modem gets its old ID back.
- The web UI calls the API on its own origin; `VITE_API_URL` is gone. A runtime `/config.js` can point it elsewhere.
- Logs are structured JSON lines (pino). `LOG_LEVEL=debug` logs every AT command and response. Message text is no longer logged.

### Fixed

- AT command injection: a PIN or phone number containing quotes, `;` or line breaks was written to the modem verbatim.
- Network mode switching never fell back to `AT^SYSCFG` on modems that answer `AT^SYSCFGEX` with `ERROR` (such as the E173).
- A newly detected modem could get the same ID as one already connected after another modem was unplugged.
- 8-bit SMS that isn't valid UTF-8 is decoded as Latin-1 instead of showing replacement characters.
- Pending AT commands and timers outlived an unplugged modem, and a hung modem let its command queue grow without limit (now capped at 32).
- A serial port streaming data without line breaks grew memory without bound (lines are now capped at 16 KB).

### Planned before `v0.1.0`

- Required bearer-token auth for REST and Socket.io.
- Safety defaults: destination allow-list, rate limits, `MAX_MODEMS=2`, one SMS per 10 s and 50 per day per modem, 5 calls per hour, message retention.
- Publishing the image to GHCR.

[Unreleased]: https://github.com/gsm2http/gsm2http/commits/main
