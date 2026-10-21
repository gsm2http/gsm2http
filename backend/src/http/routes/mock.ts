import { Router } from 'express';
import { injectMockCall, injectMockSms, type MockSmsRequest } from '../../mock/inject';
import type { ModemEntry, ModemManager } from '../../modem/ModemManager';
import { HttpError, badRequest } from '../errors';
import {
  body,
  hexPdu,
  modemId,
  optionalBoolean,
  optionalString,
  phoneNumber,
  type Body,
} from '../validation';

const DEFAULT_SENDER = '+12025550199';
const DEFAULT_CALLER = '+12025550188';

/** Simulation endpoints. Mounted only when MOCK_MODE is on. */
export function mockRouter(options: { modems: ModemManager }): Router {
  const { modems } = options;
  const router = Router();

  const targetModem = (b: Body): ModemEntry => {
    const raw = optionalString(b, 'modemId');
    const id = raw === undefined ? undefined : modemId(raw, '"modemId"');
    const modem = id ? modems.getModem(id) : modems.getDefaultModem();
    if (!modem) throw new HttpError(404, `Mock modem ${id ?? '(default)'} not found`);
    return modem;
  };

  router.post('/sms', (req, res) => {
    const b = body(req);
    const { stream } = targetModem(b);
    const { parts, indices } = injectMockSms(stream, parseMockSms(b));
    res.json({ success: true, modemId: stream.id, parts, injectedIndices: indices });
  });

  router.post('/call', (req, res) => {
    const b = body(req);
    const caller = b.number === undefined ? DEFAULT_CALLER : phoneNumber(b, 'number');
    const { stream } = targetModem(b);
    injectMockCall(stream, caller);
    res.json({ success: true, modemId: stream.id, injectedCaller: caller });
  });

  return router;
}

function parseMockSms(b: Body): MockSmsRequest {
  if (b.testCase !== undefined) {
    if (b.testCase !== 'multipart-ucs2') throw badRequest('Unknown "testCase"');
    return { kind: 'testCase', testCase: 'multipart-ucs2' };
  }
  if (b.pdus !== undefined) {
    if (!Array.isArray(b.pdus) || b.pdus.length === 0 || b.pdus.length > 16) {
      throw badRequest('"pdus" must be an array of 1 to 16 PDUs');
    }
    return { kind: 'pdus', pdus: b.pdus.map((p: unknown) => hexPdu(p, 'pdus[]')) };
  }
  if (b.pdu !== undefined) {
    return { kind: 'pdus', pdus: [hexPdu(b.pdu, 'pdu')] };
  }
  return {
    kind: 'text',
    sender: optionalString(b, 'sender') ?? DEFAULT_SENDER,
    text: optionalString(b, 'text') ?? 'Test mock SMS message',
    multipart: optionalBoolean(b, 'multipart'),
  };
}
