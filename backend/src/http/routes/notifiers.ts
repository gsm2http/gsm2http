import { Router } from 'express';
import type { NotifierHub } from '../../notifiers';

/**
 * Read-only: sinks come from CONFIG_FILE and env vars. Changing them at runtime through an
 * API would let anyone who can reach it redirect every incoming SMS.
 */
export function notifiersRouter(options: { notifiers: NotifierHub }): Router {
  const { notifiers } = options;
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ notifiers: notifiers.summaries(), deliveries: notifiers.deliveries() });
  });

  return router;
}
