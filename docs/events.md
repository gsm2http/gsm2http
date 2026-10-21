# Events

Everything gsm2http notices (an SMS arriving or being sent, a call ringing or ending, a modem being plugged in, unplugged or changing state) becomes one **event** on an internal event bus. Each consumer reads that same bus:

- **Webhooks:** an HTTP `POST` with a JSON body, to as many URLs as you like, each with its own filter, retries and HMAC signature
- **MQTT:** one topic per modem and event, Home Assistant-friendly
- **Socket.io:** a live stream on the API port, used by the web UI

All three carry the **same JSON envelope with the same event `id`**, so you can mix them and still de-duplicate.

Ready-made integrations are in [recipes/](recipes/). Machine-readable schemas are in [openapi.yaml](openapi.yaml) (under `webhooks` and `x-socketio`).

- [Event list](#event-list)
- [The envelope (schema version 1)](#the-envelope-schema-version-1)
- [Payloads](#payloads)
- [Choosing which events a sink gets](#choosing-which-events-a-sink-gets)
- [Configuration](#configuration)
- [Webhook delivery](#webhook-delivery)
- [Signatures](#signatures)
- [MQTT](#mqtt)
- [Socket.io](#socketio)
- [Migrating from the unversioned payloads](#migrating-from-the-unversioned-payloads)

## Event list

| Event | When | `data` |
|---|---|---|
| `sms.received` | A complete SMS has arrived. Multi-part messages are delivered once, already reassembled. | Sender, text, SMSC timestamp |
| `sms.sent` | `POST /api/modems/{id}/sms` succeeded: the network accepted every part. | Recipient, text, part count, message references |
| `call.incoming` | A call starts ringing. **Sent once per call**, not once per ring. | `callId`, caller ID |
| `call.ended` | An incoming call stopped ringing, or an outgoing call placed with `/dial` is over. | `callId`, direction, reason, duration |
| `modem.added` | A modem was detected and is ready. Also sent for every modem present at startup. | The [modem object](#modem-object) |
| `modem.removed` | A modem was unplugged or stopped responding. | Its last known state, with `connected: false` |
| `modem.status` | A modem's state changed: SIM status, signal, operator, network mode, dialling. Rate-limited for webhooks and MQTT. | The [modem object](#modem-object) |

The Socket.io stream also has two UI-only feeds, `modems.list` and `modem.raw`, described [below](#socketio). They are never sent to webhooks or MQTT.

## The envelope (schema version 1)

Every event has the same outer shape:

```json
{
  "schemaVersion": 1,
  "id": "evt_8f14e45fceea167a5a36dedd4bea2543",
  "event": "sms.received",
  "timestamp": "2026-10-14T19:04:12.204Z",
  "modem": {
    "id": "modem-1",
    "port": "/dev/ttyUSB0",
    "imei": "000000000000001",
    "phoneNumber": "+12025550143"
  },
  "data": {
    "sender": "+12025550199",
    "recipientNumber": "+12025550143",
    "text": "Garage door opened at 21:04",
    "sentAt": "2026-10-14T19:04:10.000Z"
  }
}
```

| Field | Notes |
|---|---|
| `schemaVersion` | `1`. See [versioning](#versioning) below. |
| `id` | Unique per event. It stays the same across retries and across sinks (webhook, MQTT, Socket.io), so use it to de-duplicate. |
| `event` | One of the names in the [event list](#event-list). Route on this field. |
| `timestamp` | When gsm2http observed the event, as ISO 8601 UTC. |
| `modem.id` | `modem-1`, `modem-2`, … in discovery order. An ID sticks to its IMEI while gsm2http runs, but can change after a restart. |
| `modem.imei` | The **stable** key for a modem. Missing only if the modem did not report one. |
| `modem.phoneNumber` | The SIM's number from `MODEM_NUMBERS`. Missing if not configured: most SIMs don't report their own number. |
| `data` | Depends on `event`; see [Payloads](#payloads). |

### Versioning

`schemaVersion` changes only for **breaking** changes: a field removed, renamed or retyped, or its meaning changed. New events and new optional fields can appear at any time within version 1, so:

- Ignore fields you don't know.
- Ignore `event` values you don't handle, and acknowledge them with a 2xx anyway (otherwise they will be retried).
- If you depend on the exact shape, check `schemaVersion === 1`.

A breaking change would be listed in [CHANGELOG.md](../CHANGELOG.md), with both versions available side by side for at least one minor release.

## Payloads

Only `data` is shown below; the rest of the envelope is as above. Optional fields are omitted when unknown rather than sent as `null`.

### `sms.received`

```json
{
  "sender": "+12025550199",
  "recipientNumber": "+12025550143",
  "text": "Garage door opened at 21:04",
  "sentAt": "2026-10-14T19:04:10.000Z"
}
```

| Field | Notes |
|---|---|
| `sender` | An E.164 number, or an alphanumeric sender ID such as `BANK` |
| `recipientNumber` | The receiving SIM's number, from `MODEM_NUMBERS`. Optional. |
| `text` | The decoded text (GSM 7-bit or UCS-2 → UTF-8) |
| `sentAt` | When the network's SMS centre accepted the message, from the PDU. It can be minutes before `timestamp` if the phone was off. |

**Multi-part SMS:** parts are held for up to **30 seconds** waiting for the rest. If a part never arrives, whatever has arrived is delivered after the timeout, so the text may be incomplete.

### `sms.sent`

```json
{
  "to": "+12025550199",
  "from": "+12025550143",
  "text": "Nightly backup OK",
  "parts": 1,
  "messageReferences": [17]
}
```

`from` is the SIM's number from `MODEM_NUMBERS` (optional). `messageReferences` holds the network's TP-Message-Reference for each part. `sms.sent` means the network accepted the message; it does not confirm delivery to the handset.

### `call.incoming`

```json
{
  "callId": "call_c790da6eec284ca28e4b6dadeb139bee",
  "direction": "inbound",
  "number": "+12025550199",
  "recipientNumber": "+12025550143"
}
```

Sent on the first ring that carries caller ID (`+CLIP`). Further rings of the same call don't send anything. `number` is empty when the caller withheld it. gsm2http never answers calls.

### `call.ended`

```json
{
  "callId": "call_c790da6eec284ca28e4b6dadeb139bee",
  "direction": "inbound",
  "number": "+12025550199",
  "reason": "missed",
  "startedAt": "2026-10-14T19:05:40.512Z",
  "durationMs": 15021,
  "rings": 4
}
```

| Field | Notes |
|---|---|
| `callId` | Matches the `call.incoming` event, or the `callId` returned by `POST /api/modems/{id}/dial` |
| `direction` | `inbound` or `outbound` |
| `number` | The caller (inbound) or the dialled number (outbound) |
| `reason` | See the table below |
| `startedAt`, `durationMs` | From the first ring, or from dialling. For an inbound call whose end was inferred from silence, measured to the last ring. |
| `rings` | Inbound only: rings seen |
| `detail` | The modem's own result line when the network ended the call, e.g. `NO CARRIER` or `^CEND:1,0,104,16` |

| `reason` | Direction | Meaning |
|---|---|---|
| `missed` | inbound | The caller gave up, or the network diverted the call to voicemail |
| `completed` | outbound | The requested duration elapsed and gsm2http hung up |
| `hangup` | outbound | Hung up with `POST /api/modems/{id}/hangup` |
| `remote_hangup` | outbound | The other side or the network ended the call |
| `busy`, `no_answer` | outbound | As reported by the modem |
| `failed` | outbound | The modem refused to dial |
| `replaced` | outbound | A new `dial` with `force: true` took over the line |
| `modem_closed` | both | The modem was unplugged, or gsm2http shut down |

An inbound call ends as soon as the modem reports it (`NO CARRIER`, or Huawei's `^CEND`). Modems that report nothing are covered by a timeout: the call is over once **10 seconds** pass without a ring. Networks ring about every 5 seconds.

### Modem object

`modem.added`, `modem.removed` and `modem.status` all carry the full modem object as `data`. It is the same object `GET /api/modems` returns:

```json
{
  "id": "modem-2",
  "port": "/dev/ttyUSB3",
  "name": "Huawei E3372 (/dev/ttyUSB3)",
  "model": "E3372",
  "manufacturer": "Huawei",
  "imei": "000000000000002",
  "driver": "huawei",
  "capabilities": { "sms": true, "voice": false, "ussd": true, "audio": false },
  "simStatus": "SIM PIN",
  "phoneNumber": "+12025550144",
  "operator": "Example Mobile",
  "signalStrength": 19,
  "signalPercentage": 61,
  "accessTechnology": "UTRAN",
  "supportsVoice": false,
  "connected": true,
  "networkMode": "auto",
  "isDialing": false
}
```

`simStatus` is one of `READY`, `SIM PIN`, `SIM PUK`, `NO SIM`, `ERROR` or `UNKNOWN`. `signalStrength` is the raw `+CSQ` value (0–31, or 99 for unknown). A modem never sends `modem.status` after its `modem.removed`.

## Choosing which events a sink gets

Each webhook and MQTT sink has a filter:

- **`events`**: a list of exact names (`sms.received`), families (`sms.*`, `call.*`, `modem.*`) or `*` for everything. Unknown names are a startup error, so a typo cannot silently drop events.
- **`modems`** (optional): only events from these modems, matched by ID, IMEI or phone number. Prefer the IMEI, since it doesn't change.

| Sink | Default `events` | Why |
|---|---|---|
| Webhook | `sms.*`, `call.*`, `modem.added`, `modem.removed` | `modem.status` changes with every signal fluctuation. On n8n or Zapier that would be a paid execution every few seconds. Opt in with `"*"` or by listing `modem.status`. |
| MQTT | `*` | Status is cheap on MQTT, and retained on its topic |

**`modem.status` rate limit.** Webhooks and MQTT get at most one `modem.status` per modem every `modemStatusMinIntervalMs` (default 10 s). In between, only the latest state is kept, and it is sent when the interval ends, so nothing is permanently stale. Socket.io and the UI get every change.

## Configuration

Sinks come from **environment variables**, a **config file**, or both. Sinks from the file are added first, then the env sinks.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `WEBHOOK_URL` | *(empty)* | One or more `http(s)` URLs, comma-separated. Each becomes its own sink (`webhook`, or `webhook-1`, `webhook-2`, …). |
| `WEBHOOK_EVENTS` | *(see above)* | Comma-separated event filter for the env webhooks, e.g. `sms.received,call.*` |
| `WEBHOOK_SECRET` | *(empty)* | Signs the env webhooks, and any file webhook without a `secret` of its own. See [Signatures](#signatures). |
| `WEBHOOK_TIMEOUT_MS` | `10000` | Per-attempt timeout |
| `WEBHOOK_MAX_ATTEMPTS` | `6` | Attempts including the first; `1` disables retries |
| `MQTT_URL` | *(empty)* | `mqtt://`, `mqtts://`, `ws://` or `wss://` broker URL. Adds one MQTT sink named `mqtt`. |
| `MQTT_USERNAME`, `MQTT_PASSWORD` | *(empty)* | Broker credentials |
| `MQTT_CLIENT_ID` | *(random)* | Fixed client ID, if your broker's ACLs need one |
| `MQTT_TOPIC_PREFIX` | `gsm2http` | First topic level |
| `MQTT_EVENTS` | `*` | Comma-separated event filter for the env MQTT sink |
| `MQTT_HA_DISCOVERY` | `false` | Publish [Home Assistant discovery](#home-assistant-discovery) |
| `MQTT_HA_PREFIX` | `homeassistant` | Home Assistant's discovery prefix |
| `MODEM_STATUS_MIN_INTERVAL_MS` | `10000` | The `modem.status` rate limit. `0` sends every change. Overrides the file's `events.modemStatusMinIntervalMs`. |
| `CONFIG_FILE` | *(empty)* | Path to a YAML config file. Not read unless set. |

### Config file

Use a file when you want several sinks with different filters, extra headers or custom retry settings. Start from [config.example.yaml](../config.example.yaml):

```yaml
events:
  modemStatusMinIntervalMs: 10000

notifiers:
  - type: webhook
    name: n8n                                   # unique; shown in logs and /api/notifiers
    url: https://n8n.example/webhook/${N8N_WEBHOOK_ID}
    events: [sms.received, call.*]
    modems: ['000000000000001']                 # optional
    secret: ${N8N_WEBHOOK_SECRET}               # optional; "" sends unsigned
    timeoutMs: 10000
    retry: { maxAttempts: 6, initialDelayMs: 10000, factor: 3, maxDelayMs: 1800000 }
    headers: { Authorization: 'Bearer ${PROXY_TOKEN}' }   # optional

  - type: mqtt
    name: home-assistant
    url: mqtt://homeassistant.local:1883
    username: gsm2http
    password: ${MQTT_PASSWORD}
    topicPrefix: gsm2http
    events: ['*']
    qos: 1                                      # 0, 1 or 2
    retainStatus: true
    homeAssistant: { discovery: true, prefix: homeassistant }
```

- **`${NAME}`** is replaced with the environment variable `NAME` (startup fails if it is unset). **`${NAME:-fallback}`** uses `fallback` instead. Write `$${` for a literal `${`. This keeps secrets in `.env` and the file safe to commit.
- **Mistakes fail at startup** with the path to the bad setting, e.g. `config.yaml.notifiers[0].events: unknown event "sms.recieved"`. Unknown keys are rejected too.
- Sinks without a `name` are called `webhook-1`, `mqtt-2`, … after their position in the list.
- With Docker, mount the file read-only and set `CONFIG_FILE`. There is a commented example in [docker-compose.yml](../docker-compose.yml).

There is no API for changing sinks at runtime. Anyone who could reach such an API could redirect every incoming SMS, `GET /api/notifiers` shows the configured sinks read-only, with URL paths and credentials removed, plus the last 100 delivery attempts (payloads are never kept). The web UI's *Notifiers* panel reads it.

## Webhook delivery

### Request

`POST` to the sink's URL with the [envelope](#the-envelope-schema-version-1) as the body:

| Header | Example | Meaning |
|---|---|---|
| `Content-Type` | `application/json` | |
| `User-Agent` | `gsm2http-webhook/1 (+https://github.com/gsm2http/gsm2http)` | |
| `X-Gsm2http-Event` | `sms.received` | Same as the body's `event` |
| `X-Gsm2http-Delivery` | `evt_8f14e45f…` | Same as the body's `id`; unchanged across retries |
| `X-Gsm2http-Attempt` | `1` | 1 for the first try, 2 for the first retry, … |
| `X-Gsm2http-Timestamp` | `1792000439` | When signed: Unix seconds at signing |
| `X-Gsm2http-Signature` | `sha256=5f2b…` | When signed: see [Signatures](#signatures) |

Headers from the sink's `headers` setting are added, but they can't override the ones above.

### Responses and retries

| Response | gsm2http does |
|---|---|
| Any **2xx** | Delivered. The response body is ignored. Respond quickly and do slow work afterwards. |
| No response within `timeoutMs`, connection error, **408**, **425**, **429**, **5xx** | Retries with exponential backoff |
| Any other **4xx** | Gives up immediately. The request itself was refused (wrong URL, auth, signature), so retrying would not help. |
| **3xx** | Gives up. Redirects are not followed: a redirected `POST` can silently turn into a `GET`. Put the final URL in the config. |

With the defaults, the waits between six attempts are about **10 s, 30 s, 90 s, 4.5 min and 13.5 min**, about 19 minutes in total, each ±20 % at random so a recovering endpoint isn't hit by everything at once. A `Retry-After` header (seconds or HTTP date) is honoured when it asks for longer, up to `maxDelayMs`. Every attempt is signed afresh, so a late retry still passes the receiver's 5-minute freshness check.

| Property | Behaviour |
|---|---|
| Ordering | Not guaranteed, especially once retries are involved. Use `timestamp` (or `sentAt`) if order matters. |
| Duplicates | Possible: a 2xx that is lost on the way back gets retried. De-duplicate on `X-Gsm2http-Delivery` / `id`. |
| Persistence | Pending retries are held in memory and **lost on restart**. On shutdown, requests already in flight get up to 2 s to finish; scheduled retries are dropped and the count is logged. For critical alerts, also subscribe over MQTT or Socket.io. |
| Back-pressure | At most 1,000 deliveries per sink can be pending (in flight or waiting to retry). Beyond that, new events for that sink are dropped and logged at `error`. |
| Logs | One JSON log line per attempt: `webhook delivered`, `webhook failed, will retry`, `webhook failed, giving up` or `webhook rejected, not retrying`, with `notifier`, `event`, `eventId`, `attempt` and `status`. |

## Signatures

When a webhook sink has a secret (its own `secret`, or `WEBHOOK_SECRET`), each request carries `X-Gsm2http-Timestamp` and `X-Gsm2http-Signature`:

```
X-Gsm2http-Signature: sha256=<hex( HMAC-SHA256( secret, "<X-Gsm2http-Timestamp>.<raw body>" ) )>
```

To verify:

1. Rebuild the signed string from the **raw** request body exactly as received. Don't re-serialise parsed JSON: key order and spacing would differ.
2. Compute the HMAC with your secret and compare it to the header **in constant time**.
3. Reject timestamps more than **5 minutes** from your clock, to stop replays.

**Test vector.** Secret `my-secret`, timestamp `1760468652` and body `{"hello":"world"}` must give:

```
sha256=12c0bea358854b7f4d7a5ae3c29663e4f60a7bdca1d71d68efb35a08a2bbccf9
```

Check your own implementation against it, or with OpenSSL:

```sh
printf '%s' '1760468652.{"hello":"world"}' | openssl dgst -sha256 -hmac my-secret
```

Complete receivers that verify signatures: [Node.js, Python and curl](recipes/receivers.md), [n8n](recipes/n8n.md#verify-the-signature).

Use a long random secret (`openssl rand -hex 32`), and a different one per receiver if they belong to different people. Signing proves that a request came from your gsm2http. It does not encrypt anything, so use `https://` for receivers outside your LAN.

## MQTT

Each event's envelope is published as JSON to:

```
<topicPrefix>/<modemId>/<family>/<action>
```

| Event | Topic (default prefix) | Retained |
|---|---|---|
| `sms.received` | `gsm2http/modem-1/sms/received` | no |
| `sms.sent` | `gsm2http/modem-1/sms/sent` | no |
| `call.incoming` | `gsm2http/modem-1/call/incoming` | no |
| `call.ended` | `gsm2http/modem-1/call/ended` | no |
| `modem.added` | `gsm2http/modem-1/modem/added` | no |
| `modem.removed` | `gsm2http/modem-1/modem/removed` | no; it also overwrites the retained status with `connected: false` |
| `modem.status` | `gsm2http/modem-1/modem/status` | **yes** (`retainStatus`), so a new subscriber gets each modem's current state at once |
| *(availability)* | `gsm2http/status` | yes: `online`, or `offline` on clean shutdown and as the last will if the connection drops |

Subscribe to `gsm2http/+/sms/received` for every modem's SMS, or `gsm2http/#` for everything.

- **QoS** 1 by default (at least once). A publish counts as delivered once the broker acknowledges it.
- **Reconnects** happen automatically every 5 s. Events published meanwhile are queued in memory (up to 1,000) and sent on reconnect. The first error of an outage is logged at `warn`; repeats until it reconnects are logged at `debug`.
- `modemId` in topics is the discovery-order ID. The IMEI is in the payload (`modem.imei`) if you need a stable key.

### Home Assistant discovery

With `homeAssistant.discovery: true` (or `MQTT_HA_DISCOVERY=true`), each modem appears in Home Assistant as a device, keyed by IMEI, with:

| Entity | Type | Source |
|---|---|---|
| Signal | sensor (%) | `data.signalPercentage` from the retained status topic |
| Operator | sensor | `data.operator` |
| SIM status | sensor | `data.simStatus` |
| Connected | binary sensor (connectivity) | `data.connected` |
| SMS | event (`sms.received`, with `sender` and `text` attributes) | `…/sms/received` |
| Incoming call | event (`call.incoming`, with `number` and `call_id`) | `…/call/incoming` |

All of them use `gsm2http/status` for availability. Discovery configs are retained and re-sent after each reconnect. Automations and examples: [recipes/home-assistant.md](recipes/home-assistant.md).

## Socket.io

The web UI's live feed runs on the same port as the API (`/socket.io`). Every event from the [event list](#event-list) is emitted under its own name with the same envelope, plus:

| Socket.io event | Payload | When |
|---|---|---|
| `modems.list` | `Modem[]` | On connect, and after every `modem.added` / `modem.removed` |
| `modem.raw` | `{ id, modemId, modemPort, modemName, event, timestamp }` | Every line read from or written to a modem |

`modem.status` is not rate-limited on Socket.io. In `modem.raw`, lines starting with `> ` are commands gsm2http sent, and lines in `[System …]` brackets are gsm2http's own notes. **The raw log contains phone numbers and PDUs that include message text.** That is why it never goes on the event bus, and so never reaches webhooks or MQTT.

```js
import { io } from 'socket.io-client';

const socket = io('http://127.0.0.1:9333', {
  auth: { token: process.env.API_TOKEN }, // required; a wrong token fails with 'unauthorized'
});

socket.on('modems.list', (modems) => console.table(modems));
socket.on('sms.received', (e) => console.log(`SMS from ${e.data.sender}: ${e.data.text}`));
socket.on('call.incoming', (e) => console.log(`Ringing: ${e.data.number}`));
socket.on('call.ended', (e) => console.log(`Call ${e.data.callId} ${e.data.reason}`));
```

## Migrating from the unversioned payloads

Before schema version 1, webhook bodies were flat objects sent to a single `WEBHOOK_URL`. Field by field:

| Before | Now |
|---|---|
| `event` | `event` (unchanged) |
| `modemId`, `modemPort` | `modem.id`, `modem.port` |
| `recipientNumber` | `data.recipientNumber` (also `modem.phoneNumber`) |
| `sender`, `text` | `data.sender`, `data.text` |
| `timestamp` (SMS) | `data.sentAt` (SMSC time). The top-level `timestamp` is now when gsm2http saw the event. |
| `number`, `callerId` (call) | `data.number`; `callerId` is gone |
| One `call.incoming` per ring | One per call, with `data.callId`, then `call.ended` |
| `modem.status` (Socket.io): bare modem | Envelope, modem in `data` |
| `POST /api/config/webhook` | Removed. Set `WEBHOOK_URL` or use `CONFIG_FILE`. |

In n8n that means `{{ $json.body.sender }}` becomes `{{ $json.body.data.sender }}`; in Home Assistant, `trigger.json.sender` becomes `trigger.json.data.sender`.
