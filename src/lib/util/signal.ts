import { logger } from "@wiggler/lib/logging/logger";

/**
 * Registers SIGINT/SIGTERM handlers that abort the returned controller.
 * Idempotent at the process level so multiple collectors can co-exist.
 */
export function createShutdownController(): AbortController {
  const controller = new AbortController();
  let triggered = false;

  const onSignal = (signal: NodeJS.Signals): void => {
    if (triggered) {
      return;
    }
    triggered = true;
    logger.info("shutdown signal received", { signal });
    controller.abort();
  };

  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));

  return controller;
}
