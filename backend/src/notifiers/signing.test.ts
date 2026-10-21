import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { sign, signatureHeaders, verifySignature } from './signing';

const SECRET = 'whsec_test_0123456789';
const BODY = '{"schemaVersion":1,"event":"sms.received","data":{"text":"héllo 👋"}}';

describe('webhook signing', () => {
  it('is hex HMAC-SHA256 over "<timestamp>.<body>", as documented', () => {
    const expected = createHmac('sha256', SECRET).update(`1760468652.${BODY}`).digest('hex');
    assert.equal(sign(SECRET, 1760468652, BODY), `sha256=${expected}`);
  });

  it('matches a fixed test vector, so receivers in other languages can check themselves', () => {
    // Also printed in docs/events.md#signatures; computed independently with
    // printf '%s' '1760468652.{"hello":"world"}' | openssl dgst -sha256 -hmac my-secret
    assert.equal(
      sign('my-secret', 1760468652, '{"hello":"world"}'),
      'sha256=12c0bea358854b7f4d7a5ae3c29663e4f60a7bdca1d71d68efb35a08a2bbccf9',
    );
  });

  it('puts unix seconds in the timestamp header', () => {
    const headers = signatureHeaders(SECRET, BODY, 1_760_468_652_999);
    assert.equal(headers['X-Gsm2http-Timestamp'], '1760468652');
    assert.equal(headers['X-Gsm2http-Signature'], sign(SECRET, 1760468652, BODY));
  });

  it('verifies a fresh, untampered request', () => {
    const now = 1_760_468_652_000;
    const { 'X-Gsm2http-Timestamp': timestamp, 'X-Gsm2http-Signature': signature } =
      signatureHeaders(SECRET, BODY, now);
    assert.ok(verifySignature({ secret: SECRET, body: BODY, timestamp, signature, now }));
  });

  it('rejects a wrong secret, a changed body, a swapped timestamp and stale requests', () => {
    const now = 1_760_468_652_000;
    const { 'X-Gsm2http-Timestamp': timestamp, 'X-Gsm2http-Signature': signature } =
      signatureHeaders(SECRET, BODY, now);
    const base = { secret: SECRET, body: BODY, timestamp, signature, now };

    assert.ok(!verifySignature({ ...base, secret: 'other' }));
    assert.ok(!verifySignature({ ...base, body: BODY.replace('héllo', 'hello') }));
    assert.ok(!verifySignature({ ...base, timestamp: String(Number(timestamp) + 1) }));
    assert.ok(!verifySignature({ ...base, now: now + 301_000 }), 'older than 5 minutes');
    assert.ok(!verifySignature({ ...base, now: now - 301_000 }), 'from the future');
    assert.ok(verifySignature({ ...base, now: now + 299_000 }));
    assert.ok(!verifySignature({ ...base, signature: undefined }));
    assert.ok(!verifySignature({ ...base, timestamp: 'nope' }));
    assert.ok(!verifySignature({ ...base, signature: 'sha256=00' }), 'length mismatch is safe');
  });
});
