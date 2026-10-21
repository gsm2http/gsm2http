# Node-RED

## Receive events over MQTT

Node-RED's built-in **mqtt in** node is the simplest option if you run a broker:

1. Configure gsm2http with `MQTT_URL=mqtt://broker.local:1883` (see [events.md](../events.md#mqtt)).
2. Add an **mqtt in** node: topic `gsm2http/+/sms/received` (or `gsm2http/#` for everything), output *a parsed JSON object*.
3. Use `msg.payload.data.sender` and `msg.payload.data.text`. `msg.topic` tells you which modem and event it was.

`call.incoming` (`gsm2http/+/call/incoming`) fires once per call; `call.ended` follows with `msg.payload.data.reason`.

## Receive events over a webhook

1. Add an **http in** node: method `POST`, URL `/gsm2http`.
2. Connect an **http response** node (status 204) straight after it, so gsm2http gets a reply quickly.
3. Connect a **switch** node on `msg.payload.event`, with outputs for `sms.received`, `call.incoming` and `call.ended`.
4. Set gsm2http's `WEBHOOK_URL` to `http://node-red.local:1880/gsm2http`.

To verify signatures, add a **function** node before the switch, using the logic from [receivers.md](receivers.md#nodejs-express). The **http in** node parses JSON, so check against `JSON.stringify(msg.payload)` only if you can't get the raw body. That works for gsm2http's compact JSON but is fragile, so prefer MQTT on an untrusted network.

## Call the API

**http request** node:

- Method: `POST`
- URL: `http://gsm2http.local:9333/api/modems/modem-1/dial`
- Headers: `Authorization: Bearer <API_TOKEN>`, `Content-Type: application/json`
- `msg.payload`: `{ "to": "+12025550199", "durationSeconds": 20 }`

## Live stream

For a dashboard without a broker, connect a Socket.io client node (from a community palette) to `http://gsm2http.local:9333` with `auth: { token: '<API_TOKEN>' }` and subscribe to `modem.status` and `sms.received`. Payloads are the same envelopes; see [events.md](../events.md#socketio).
