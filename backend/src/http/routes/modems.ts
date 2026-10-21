import { Router, type Request } from 'express';
import type { RateLimits } from '../../config';
import type { ModemEntry, ModemManager } from '../../modem/ModemManager';
import { PinAttemptsError } from '../../modem/ModemStream';
import { HttpError, tooManyRequests } from '../errors';
import { RateLimiter } from '../rateLimit';
import {
  body,
  callDuration,
  modemId,
  networkMode,
  optionalBoolean,
  phoneNumber,
  simPin,
  smsText,
} from '../validation';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export function modemsRouter(options: {
  modems: ModemManager;
  defaultCallDurationMs: number;
  rateLimits: RateLimits;
}): Router {
  const { modems, defaultCallDurationMs, rateLimits } = options;
  const router = Router();
  const limiters = {
    // One SMS per interval: a window as long as the gap, holding a single message.
    'SMS interval': new RateLimiter(
      rateLimits.smsMinIntervalMs > 0 ? 1 : 0,
      rateLimits.smsMinIntervalMs,
    ),
    'daily SMS': new RateLimiter(rateLimits.smsDailyLimit, DAY_MS),
    'hourly call': new RateLimiter(rateLimits.callsHourlyLimit, HOUR_MS),
    'hourly PIN unlock': new RateLimiter(rateLimits.unlocksHourlyLimit, HOUR_MS),
  };

  const requireModem = (req: Request<{ id: string }>): ModemEntry => {
    const id = modemId(req.params.id);
    const modem = modems.getModem(id);
    if (!modem) throw new HttpError(404, `Modem ${id} not found`);
    return modem;
  };

  /**
   * Counts a request against every named limit, or none of them if one is used up. Limits
   * are per modem: each is a SIM with its own bill and its own PIN counter.
   */
  const consume = (id: string, ...names: (keyof typeof limiters)[]): void => {
    for (const name of names) {
      const result = limiters[name].isBlocked(id);
      if (!result.allowed) {
        throw tooManyRequests(`${name} limit reached for modem ${id}`, result.retryAfterMs);
      }
    }
    for (const name of names) limiters[name].hit(id);
  };

  router.get('/', (_req, res) => {
    res.json({ modems: modems.getModemList() });
  });

  router.post('/scan', async (_req, res) => {
    res.json({ success: true, modems: await modems.scan() });
  });

  router.post('/:id/unlock', async (req, res) => {
    const pin = simPin(body(req));
    const { stream } = requireModem(req);
    consume(stream.id, 'hourly PIN unlock');
    let unlocked;
    try {
      unlocked = await stream.unlock(pin);
    } catch (err) {
      if (err instanceof PinAttemptsError) {
        throw new HttpError(409, err.message, { pinAttemptsLeft: err.attemptsLeft ?? null });
      }
      throw err;
    }
    if (!unlocked) throw new HttpError(400, `Modem ${stream.id} rejected the PIN`);
    res.json({ success: true, message: `SIM unlocked on modem ${stream.id}` });
  });

  router.post('/:id/query', async (req, res) => {
    const { stream, parser } = requireModem(req);
    await stream.queryDiagnostics();
    if (stream.getSimStatus() === 'READY') await parser.pollMessages();
    res.json({ success: true, message: `Diagnostic queries sent to modem ${stream.id}` });
  });

  router.post('/:id/network', async (req, res) => {
    const mode = networkMode(body(req));
    const { stream } = requireModem(req);
    await stream.setNetworkMode(mode);
    res.json({ success: true, message: `Switched network to ${mode} on modem ${stream.id}` });
  });

  router.post('/:id/sms', async (req, res) => {
    const b = body(req);
    const to = phoneNumber(b, 'to');
    const text = smsText(b);
    const { stream } = requireModem(req);

    if (!stream.capabilities.sms) {
      throw new HttpError(400, `Modem ${stream.id} (${stream.model}) does not support SMS`);
    }
    if (stream.getSimStatus() !== 'READY') {
      throw new HttpError(409, `Modem ${stream.id} SIM is not ready (${stream.getSimStatus()})`);
    }
    consume(stream.id, 'daily SMS', 'SMS interval');

    let result;
    try {
      result = await stream.sendSms(to, text);
    } catch (err) {
      throw new HttpError(502, err instanceof Error ? err.message : String(err));
    }
    res.json({
      success: true,
      modemId: stream.id,
      from: stream.phoneNumber ?? stream.id,
      to,
      parts: result.parts,
      messageReferences: result.messageReferences,
    });
  });

  router.post('/:id/dial', async (req, res) => {
    const b = body(req);
    const to = phoneNumber(b, 'to');
    const durationMs = callDuration(b, defaultCallDurationMs);
    const sync = optionalBoolean(b, 'sync');
    const force = optionalBoolean(b, 'force');
    const { stream } = requireModem(req);

    if (!stream.supportsVoice) {
      throw new HttpError(400, `Modem ${stream.id} (${stream.model}) does not support voice calls`);
    }
    consume(stream.id, 'hourly call');

    const result = stream.dial(to, durationMs, { force });
    if (!result.success) {
      if (result.busy) throw new HttpError(409, result.message, { busy: true, modemId: stream.id });
      throw new HttpError(400, result.message);
    }

    const completion = sync ? await result.completion : undefined;
    res.json({
      success: true,
      completed: completion !== undefined,
      message: completion?.message ?? result.message,
      callId: result.callId,
      durationMs,
      from: stream.phoneNumber ?? stream.id,
      to,
      modemId: stream.id,
      modemPort: stream.portPath,
    });
  });

  router.post('/:id/hangup', (req, res) => {
    const { stream } = requireModem(req);
    stream.hangup();
    res.json({ success: true, message: `Hung up modem ${stream.id}`, modemId: stream.id });
  });

  return router;
}
