# n8n

Receive SMS and call events in a workflow, check they really came from your gsm2http, and call the REST API back to reply or ring a phone.

## 1. Receive events

1. Add a **Webhook** node:
   - *HTTP Method*: `POST`
   - *Path*: something hard to guess, e.g. `gsm2http-7f3c`
   - *Respond*: *Immediately* (gsm2http only needs a 2xx; slow responses time out and get retried)
   - *Options → Raw Body*: **on**, so the signature can be checked
2. Point gsm2http at the node's **Production URL**, with a secret:

   ```sh
   # .env
   WEBHOOK_URL=https://n8n.example/webhook/gsm2http-7f3c
   WEBHOOK_SECRET=replace-with-output-of-openssl-rand-hex-32
   ```

   Or, with other sinks in a [config file](../events.md#config-file):

   ```yaml
   notifiers:
     - type: webhook
       name: n8n
       url: https://n8n.example/webhook/${N8N_WEBHOOK_ID}
       secret: ${N8N_WEBHOOK_SECRET}
       events: [sms.received, call.incoming, call.ended]
   ```

   Restart gsm2http. The UI's *Notifiers* panel shows each delivery.

3. Add a **Switch** node after it that routes on `{{ $json.body.event }}`:
   - `sms.received`: `{{ $json.body.data.sender }}` and `{{ $json.body.data.text }}`
   - `call.incoming`: `{{ $json.body.data.number }}`, once per call
   - `call.ended`: `{{ $json.body.data.reason }}`, e.g. `missed`

   Add a fallback output that does nothing: new event types may appear, and they should just be acknowledged.

`{{ $json.body.modem.imei }}` identifies the modem stably; `modem.id` (`modem-1`) follows discovery order.

## 2. Verify the signature

Put a **Code** node (*Run Once for All Items*) between the Webhook and Switch nodes. On self-hosted n8n, allow the built-in crypto module with `NODE_FUNCTION_ALLOW_BUILTIN=crypto`.

```js
const crypto = require('crypto');

// Paste the same value as gsm2http's WEBHOOK_SECRET, or read it with $env
// if your instance allows environment access in nodes.
const SECRET = 'replace-with-your-webhook-secret';

const item = $input.first();
const headers = item.json.headers;
const ts = headers['x-gsm2http-timestamp'] ?? '';
const sig = headers['x-gsm2http-signature'] ?? '';

// The raw body, exactly as signed (needs Options → Raw Body on the Webhook node).
const raw = (await this.helpers.getBinaryDataBuffer(0, 'data')).toString('utf8');

const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(`${ts}.${raw}`).digest('hex');
const fresh = /^\d+$/.test(ts) && Math.abs(Date.now() / 1000 - Number(ts)) <= 300;
const valid =
  sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));

if (!fresh || !valid) {
  throw new Error('gsm2http signature check failed');
}

// Pass the parsed event on, so the next nodes can use $json.body.* as before.
return [{ json: { ...item.json, body: JSON.parse(raw) } }];
```

A failed check stops the execution, so nothing downstream runs. The webhook has already been answered with 200, so gsm2http won't retry a forged request.

To try it without a modem, run gsm2http with `MOCK_MODE=true` and press *Simulate SMS* in the UI, or:

```sh
curl -X POST http://127.0.0.1:9333/api/mock/sms \
  -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"sender":"+12025550199","text":"hello from mock mode"}'
```

## 3. Call the API back

### Reply to an SMS

Add an **HTTP Request** node on the `sms.received` branch:

| Setting | Value |
|---|---|
| Method | `POST` |
| URL | `http://gsm2http:9333/api/modems/{{ $json.body.modem.imei }}/sms` |
| Authentication | Generic → Header Auth: `Authorization` = `Bearer <API_TOKEN>` |
| Body (JSON) | `{ "to": "{{ $json.body.data.sender }}", "text": "Got it, thanks" }` |

Addressing the modem by IMEI sends the reply from the SIM the message arrived on.

- Alphanumeric senders (`BANK`, `DHL`) can't be replied to. Add an **IF** node on `{{ /^\+?\d+$/.test($json.body.data.sender) }}` first.
- Two auto-responders can text each other forever. Reply at most once per sender per hour (e.g. with workflow static data), and never reply to `sms.sent`.

### Ring a phone

Same node, URL `…/api/modems/modem-1/dial`, body `{ "to": "+12025550199", "durationSeconds": 20 }`. The response has a `callId`. A later `call.ended` event with the same `callId` tells you when the call is over and why (`completed`, `busy`, `no_answer`, …).

### Example: SMS → AI triage → act

Webhook (`sms.received`) → signature check → an LLM node that classifies the message → IF *urgent* → HTTP Request (dial your own phone), else HTTP Request (`/sms` with an automatic reply, rate-limited as above).

An n8n community node (`n8n-nodes-gsm2http`) with a trigger and these actions is on the roadmap.
