import { Router } from 'express';
import type { NotifierHub } from '../../notifiers';

export function configRouter(options: {
  notifiers: NotifierHub;
  mockMode: boolean;
  defaultCallDurationMs: number;
  authEnabled: boolean;
}): Router {
  const { notifiers, mockMode, defaultCallDurationMs, authEnabled } = options;
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({
      mockMode,
      authEnabled,
      defaultCallDurationMs,
      notifierCount: notifiers.size,
    });
  });

  return router;
}
