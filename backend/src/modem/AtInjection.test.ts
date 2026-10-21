import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { GenericDriver } from './drivers/GenericDriver';
import { GENERIC_PROFILE, HUAWEI_PROFILE, startModem } from './drivers/testUtils';
import type { ModemContext } from './drivers/types';
import { PinAttemptsError, type ModemStream } from './ModemStream';

/** Strings that would smuggle a second AT command (or end the SMS prompt) if passed through. */
const INJECTIONS = [
  '+12025550199;+CFUN=0',
  '+12025550199\r\nAT+CFUN=0',
  '+12025550199\rAT+CMGD=1,4',
  '+12025550199\nATZ',
  '+12025550199\x1A',
  '+12025550199\x1B',
  '1234";+CLCK="SC",0,"1234',
  '*#06#',
  '+1202555019A',
];

describe('AT command injection (stream and driver layer)', () => {
  let stream: ModemStream | null = null;

  afterEach(() => {
    stream?.removeAllListeners();
    stream?.close();
    stream = null;
  });

  it('never writes a command containing control characters to the port', async () => {
    const m = await startModem(GENERIC_PROFILE);
    stream = m.stream;
    for (const command of ['AT\r\nAT+CFUN=0', 'AT+CPIN?\x1A', 'AT\x1B', 'AT\x00', 'ATIé']) {
      await assert.rejects(stream.sendCommand(command), /control characters/, command);
    }
    assert.deepEqual(m.port.received, []);
  });

  it('never writes a non-hex payload after the SMS prompt', async () => {
    const m = await startModem(GENERIC_PROFILE);
    stream = m.stream;
    const { ctx } = stream as unknown as { ctx: ModemContext };
    for (const payload of ['00\x1AAT+CFUN=0', 'hello', '0', '0011\r\n']) {
      await assert.rejects(ctx.sendWithPrompt('AT+CMGS=5', payload), /not hex/, payload);
    }
    assert.deepEqual(m.port.received, []);
  });

  it('refuses to dial anything but "+" and digits', async () => {
    const m = await startModem(HUAWEI_PROFILE);
    stream = m.stream;
    for (const number of INJECTIONS) {
      const result = stream.dial(number, 1_000);
      assert.equal(result.success, false, JSON.stringify(number));
      // The driver checks again, for callers that bypass the stream.
      await assert.rejects(new GenericDriver().dial(fakeCtx(m.port.received), number));
    }
    assert.ok(!m.port.received.some((c) => c.startsWith('ATD')));
  });

  it('refuses SMS recipients that are not "+" and digits', async () => {
    const m = await startModem(GENERIC_PROFILE);
    stream = m.stream;
    for (const to of INJECTIONS) {
      await assert.rejects(stream.sendSms(to, 'hi'), /Recipient/, JSON.stringify(to));
    }
    assert.ok(!m.port.received.some((c) => c.startsWith('AT+CMGS')));
  });

  it('refuses SIM PINs that are not 4 to 8 digits', async () => {
    const m = await startModem({ ...GENERIC_PROFILE, simStatus: 'SIM PIN' });
    stream = m.stream;
    for (const pin of ['123', '123456789', '12a4', '1234"\r\nAT+CFUN=0', '1234;', '1234\x1A']) {
      await assert.rejects(stream.unlock(pin), /4 to 8 digits/, JSON.stringify(pin));
      await assert.rejects(new GenericDriver().unlock(fakeCtx(m.port.received), pin));
    }
    assert.deepEqual(m.simulator.pinAttempts, []);
  });
});

describe('SIM PIN attempt guard', () => {
  let stream: ModemStream | null = null;

  afterEach(() => {
    stream?.removeAllListeners();
    stream?.close();
    stream = null;
  });

  for (const [name, profile] of [
    ['generic (AT+CPINR)', GENERIC_PROFILE],
    ['huawei (AT^CPIN?)', HUAWEI_PROFILE],
  ] as const) {
    it(`never spends the last PIN attempt: ${name}`, async () => {
      const m = await startModem({ ...profile, simStatus: 'SIM PIN', pin: '1234' });
      stream = m.stream;

      assert.equal(await stream.unlock('0000'), false); // 3 -> 2 left
      assert.equal(await stream.unlock('1111'), false); // 2 -> 1 left
      await assert.rejects(stream.unlock('1234'), (err: unknown) => {
        assert.ok(err instanceof PinAttemptsError);
        assert.equal(err.attemptsLeft, 1);
        return true;
      });

      assert.deepEqual(m.simulator.pinAttempts, ['0000', '1111']);
      assert.equal(m.simulator.simStatus, 'SIM PIN', 'the SIM must not be PUK-locked');
    });
  }

  it('serializes concurrent unlocks so parallel requests cannot PUK-lock the SIM', async () => {
    const m = await startModem({ ...GENERIC_PROFILE, simStatus: 'SIM PIN', pin: '1234' });
    stream = m.stream;

    const results = await Promise.allSettled(
      ['0000', '1111', '2222', '3333'].map((pin) => stream!.unlock(pin)),
    );
    assert.deepEqual(
      results.map((r) => r.status),
      ['fulfilled', 'fulfilled', 'rejected', 'rejected'],
    );
    assert.deepEqual(m.simulator.pinAttempts, ['0000', '1111']);
    assert.equal(m.simulator.simStatus, 'SIM PIN', 'the SIM must not be PUK-locked');
  });

  it('allows only one wrong PIN when the modem cannot report attempts left', async () => {
    const m = await startModem({
      ...GENERIC_PROFILE,
      simStatus: 'SIM PIN',
      pin: '1234',
      reportsPinAttempts: false,
    });
    stream = m.stream;

    assert.equal(await stream.unlock('0000'), false);
    await assert.rejects(stream.unlock('1234'), PinAttemptsError);
    assert.deepEqual(m.simulator.pinAttempts, ['0000']);
  });

  it('refuses a PUK-locked SIM outright', async () => {
    const m = await startModem({ ...GENERIC_PROFILE, simStatus: 'SIM PUK' });
    stream = m.stream;
    await assert.rejects(stream.unlock('1234'), /PUK-locked/);
    assert.deepEqual(m.simulator.pinAttempts, []);
  });

  it('unlocks normally with attempts to spare', async () => {
    const m = await startModem({ ...GENERIC_PROFILE, simStatus: 'SIM PIN', pin: '1234' });
    stream = m.stream;
    assert.equal(await stream.unlock('1234'), true);
    assert.equal(stream.getSimStatus(), 'READY');
  });
});

/** A context that records commands instead of sending them. */
function fakeCtx(sent: string[]): ModemContext {
  return {
    send: (command: string) => {
      sent.push(command);
      return Promise.resolve(['OK']);
    },
  } as unknown as ModemContext;
}
