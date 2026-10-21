import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ATParser, type ParsedSmsEvent } from '../ATParser';
import { ModemStream } from '../ModemStream';
import { SimulatedModem } from '../mock/SimulatedModem';
import { GENERIC_PROFILE, startModem, waitFor } from './testUtils';

describe('GenericDriver (on a simulated 3GPP modem)', () => {
  let stream: ModemStream | null = null;

  afterEach(() => {
    stream?.removeAllListeners();
    stream?.close();
    stream = null;
  });

  it('is chosen for unknown hardware and runs the standard init sequence', async () => {
    const simulator = new SimulatedModem(GENERIC_PROFILE, '/dev/ttyFAKE1');
    stream = new ModemStream({
      id: 'g1',
      portPath: '/dev/ttyFAKE1',
      transport: simulator.port,
      simulator,
      identity: simulator.identity,
    });
    assert.equal(stream.driver.name, 'generic');

    await waitFor(() => stream!.operatorName === 'Test Net', 2000, 'startup');
    const sent = simulator.port.received;
    const init = ['AT+CFUN=1', 'AT+CPMS="SM","SM","SM"', 'AT+CMGF=0', 'AT+CNMI=2,1,0,0,0'];
    assert.deepEqual(
      sent.filter((c) => init.includes(c)),
      init,
    );
    assert.ok(!sent.some((c) => c.startsWith('AT^')), 'no vendor commands sent to a generic modem');

    const info = stream.getInfo();
    assert.equal(info.driver, 'generic');
    assert.equal(info.simStatus, 'READY');
    assert.equal(info.signalStrength, 20);
    assert.equal(info.accessTechnology, 'UTRAN');
    assert.deepEqual(info.capabilities, { sms: true, voice: false, ussd: true, audio: false });
    assert.equal(info.supportsVoice, false);
  });

  it('sends a single-part SMS as an SMS-SUBMIT PDU via AT+CMGS', async () => {
    const m = await startModem(GENERIC_PROFILE);
    stream = m.stream;

    const result = await stream.sendSms('+46708251358', 'hellohello');

    assert.deepEqual(result, { parts: 1, messageReferences: [1] });
    assert.ok(m.port.received.includes('AT+CMGS=23'));
    assert.deepEqual(m.simulator.sentPdus, ['0011000B916407281553F80000AA0AE8329BFD4697D9EC37']);
  });

  it('splits long messages into concatenated parts', async () => {
    const m = await startModem(GENERIC_PROFILE);
    stream = m.stream;

    const text = 'Ünïcödé '.repeat(12); // 96 UCS-2 characters -> 2 parts of max 67
    const result = await stream.sendSms('+15555550100', text);

    assert.equal(result.parts, 2);
    assert.deepEqual(result.messageReferences, [1, 2]);
    assert.equal(m.simulator.sentPdus.length, 2);
    for (const pdu of m.simulator.sentPdus) {
      assert.equal(parseInt(pdu.slice(2, 4), 16) & 0x40, 0x40, 'UDHI flag set on every part');
    }
  });

  it('refuses to send while the SIM is locked, and reports modem errors', async () => {
    const locked = await startModem({ ...GENERIC_PROFILE, simStatus: 'SIM PIN' });
    stream = locked.stream;
    await assert.rejects(stream.sendSms('+15555550100', 'hi'), /SIM is not ready/);
    stream.removeAllListeners();
    stream.close();

    const m = await startModem(GENERIC_PROFILE);
    stream = m.stream;
    m.port.onCommand(/^AT\+CMGS=/, '+CMS ERROR: 330');
    await assert.rejects(stream.sendSms('+15555550100', 'hi'), /CMS ERROR: 330/);
  });

  it('unlocks the SIM with AT+CPIN and then runs init', async () => {
    const m = await startModem({ ...GENERIC_PROFILE, simStatus: 'SIM PIN', pin: '4321' });
    stream = m.stream;
    assert.equal(stream.getSimStatus(), 'SIM PIN');

    assert.equal(await stream.unlock('0000'), false);
    assert.equal(stream.getSimStatus(), 'SIM PIN');

    assert.equal(await stream.unlock('4321'), true);
    assert.equal(stream.getSimStatus(), 'READY');
    assert.ok(m.port.received.includes('AT+CPIN="4321"'));
    assert.ok(m.port.received.includes('AT+CNMI=2,1,0,0,0'));
  });

  it('switches network mode with AT+WS46', async () => {
    const m = await startModem(GENERIC_PROFILE);
    stream = m.stream;

    await stream.setNetworkMode('2g');
    await stream.setNetworkMode('auto');
    assert.deepEqual(
      m.port.received.filter((c) => c.startsWith('AT+WS46')),
      ['AT+WS46=12', 'AT+WS46=25'],
    );
    assert.equal(stream.getInfo().networkMode, 'auto');
  });

  it('parses unsolicited signal / SIM lines and routes +CMTI to the SMS parser', async () => {
    const m = await startModem(GENERIC_PROFILE);
    stream = m.stream;
    const parser = new ATParser(stream);
    const received: ParsedSmsEvent[] = [];
    parser.on('sms', (sms) => received.push(sms));

    m.port.inject('\r\n+CSQ: 9,99\r\n');
    assert.equal(stream.signalStrength, 9);
    assert.equal(stream.signalPercentage, 29);

    m.simulator.receiveSms('7', '+15555550177', 'over the generic driver');
    await waitFor(() => received.length === 1, 1000, 'sms');
    assert.equal(received[0]?.text, 'over the generic driver');
    assert.ok(m.port.received.includes('AT+CMGD=7'));
    parser.close();
  });

  it('dials only when the modem reports voice, and ends the call on NO CARRIER', async () => {
    const m = await startModem(GENERIC_PROFILE);
    stream = m.stream;
    assert.equal(stream.dial('+15555550100', 5000).success, false);

    // A driver/capability upgrade (as a vendor driver would report) enables dialling
    stream.capabilities.voice = true;
    m.simulator.profile.voice = true;
    const result = stream.dial('+15555550100', 5000);
    assert.equal(result.success, true);
    await waitFor(() => m.port.received.includes('ATD+15555550100;'), 500, 'ATD');

    m.port.inject('\r\nNO CARRIER\r\n');
    const done = await result.completion!;
    assert.match(done.message, /NO CARRIER/);
    assert.equal(stream.isDialing, false);
    await waitFor(() => m.port.received.includes('ATH'), 500, 'ATH');
    assert.ok(m.port.received.includes('AT+CHUP'));
  });
});
