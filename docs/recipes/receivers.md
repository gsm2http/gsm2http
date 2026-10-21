# Webhook receivers

Minimal receivers that **verify the signature** and print each event. Copy one as the starting point for your own. They all follow [events.md#signatures](../events.md#signatures):

1. Read the **raw** body (don't re-serialise parsed JSON).
2. Compare `X-Gsm2http-Signature` with `sha256=` + hex HMAC-SHA256 of `"<X-Gsm2http-Timestamp>.<raw body>"`, in constant time.
3. Reject timestamps more than 5 minutes off.
4. Reply 2xx quickly. Any other 4xx is never retried; 5xx and timeouts are.
5. De-duplicate on `X-Gsm2http-Delivery` (the event `id`), because a retry can deliver an event twice.

Configure gsm2http with the receiver's URL and the same secret:

```sh
# .env
WEBHOOK_URL=http://receiver.lan:8080/gsm2http
WEBHOOK_SECRET=replace-with-output-of-openssl-rand-hex-32
```

## Node.js (Express)

```js
// receiver.mjs: npm install express; WEBHOOK_SECRET=... node receiver.mjs
import crypto from 'node:crypto';
import express from 'express';

const SECRET = process.env.WEBHOOK_SECRET;
const seen = new Set(); // use a TTL cache or your database in production

function verify(req) {
  const ts = req.get('X-Gsm2http-Timestamp') ?? '';
  const sig = req.get('X-Gsm2http-Signature') ?? '';
  const expected =
    'sha256=' + crypto.createHmac('sha256', SECRET).update(`${ts}.${req.body}`).digest('hex');
  const fresh = /^\d+$/.test(ts) && Math.abs(Date.now() / 1000 - Number(ts)) <= 300;
  return (
    fresh &&
    sig.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  );
}

const app = express();

// express.raw keeps the exact bytes that were signed.
app.post('/gsm2http', express.raw({ type: 'application/json' }), (req, res) => {
  if (!verify(req)) return res.sendStatus(401);
  res.sendStatus(204); // acknowledge first, then do the work

  const event = JSON.parse(req.body);
  if (seen.has(event.id)) return;
  seen.add(event.id);

  switch (event.event) {
    case 'sms.received':
      console.log(`SMS to ${event.modem.id} from ${event.data.sender}: ${event.data.text}`);
      break;
    case 'call.incoming':
      console.log(`Ringing: ${event.data.number || 'withheld'} (${event.data.callId})`);
      break;
    case 'call.ended':
      console.log(`Call ${event.data.callId} ended: ${event.data.reason}`);
      break;
    default:
      console.log(event.event, event.data); // new events may appear: ignore what you don't need
  }
});

app.listen(8080, () => console.log('listening on :8080'));
```

## Python (standard library only)

No dependencies, so it runs on any box with Python 3.

```python
#!/usr/bin/env python3
# receiver.py: WEBHOOK_SECRET=... python3 receiver.py
import hashlib, hmac, json, os, time
from http.server import BaseHTTPRequestHandler, HTTPServer

SECRET = os.environ["WEBHOOK_SECRET"].encode()


def verify(headers, body: bytes) -> bool:
    ts = headers.get("X-Gsm2http-Timestamp", "")
    sig = headers.get("X-Gsm2http-Signature", "")
    if not ts.isdigit() or abs(time.time() - int(ts)) > 300:
        return False
    expected = "sha256=" + hmac.new(SECRET, ts.encode() + b"." + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(sig, expected)


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if not verify(self.headers, body):
            self.send_response(401)
            self.end_headers()
            return
        self.send_response(204)
        self.end_headers()

        event = json.loads(body)
        data = event["data"]
        if event["event"] == "sms.received":
            print(f"SMS from {data['sender']}: {data['text']}")
        elif event["event"] == "call.incoming":
            print(f"Ringing: {data['number'] or 'withheld'}")
        else:
            print(event["event"], data)


HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
```

## Python (Flask)

```python
import hashlib, hmac, json, os, time
from flask import Flask, abort, request

app = Flask(__name__)
SECRET = os.environ["WEBHOOK_SECRET"].encode()


@app.post("/gsm2http")
def gsm2http():
    ts = request.headers.get("X-Gsm2http-Timestamp", "")
    sig = request.headers.get("X-Gsm2http-Signature", "")
    body = request.get_data()  # raw bytes, before any JSON parsing
    expected = "sha256=" + hmac.new(SECRET, ts.encode() + b"." + body, hashlib.sha256).hexdigest()
    if not ts.isdigit() or abs(time.time() - int(ts)) > 300 or not hmac.compare_digest(sig, expected):
        abort(401)

    event = json.loads(body)
    print(event["event"], event["data"])
    return "", 204
```

## Test your receiver with curl

Send a correctly signed `sms.received` without a modem. This is handy in CI, or while writing a receiver in another language:

```sh
#!/bin/sh
# signed-test.sh <url>: needs WEBHOOK_SECRET in the environment
url=${1:-http://127.0.0.1:8080/gsm2http}
ts=$(date +%s)
body='{"schemaVersion":1,"id":"evt_test0000000000000000000000000001","event":"sms.received","timestamp":"2026-10-14T19:04:12.204Z","modem":{"id":"modem-1","port":"/dev/ttyUSB0","imei":"000000000000001"},"data":{"sender":"+12025550199","text":"signed test","sentAt":"2026-10-14T19:04:10.000Z"}}'
sig=$(printf '%s' "$ts.$body" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | sed 's/^.* //')

curl -sS -i "$url" \
  -H 'Content-Type: application/json' \
  -H 'X-Gsm2http-Event: sms.received' \
  -H 'X-Gsm2http-Delivery: evt_test0000000000000000000000000001' \
  -H "X-Gsm2http-Timestamp: $ts" \
  -H "X-Gsm2http-Signature: sha256=$sig" \
  --data-binary "$body"
```

Expect `204`. Changing one character of `body` after signing should give `401`.

Or let gsm2http itself send real events: run it with `MOCK_MODE=true` and use the UI's test buttons, or `POST /api/mock/sms` and `POST /api/mock/call` (see [scripts.md](scripts.md)).
