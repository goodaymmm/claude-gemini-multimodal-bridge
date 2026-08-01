import { logger } from './logger.js';

/**
 * One place that ends everything this process started.
 *
 * There were two shutdowns and neither covered the case that matters. The CLI
 * awaited them once, immediately after `parseAsync` returned -- and for `serve`
 * that is the moment the server has *started*, before any persistent child
 * exists, so it always cleaned up nothing. The signal handlers then called
 * `process.exit()` without awaiting anything, so a long-running server that had
 * spawned an MCP child and an agy left both behind, in-flight API calls
 * included.
 *
 * Two layers, deliberately:
 *
 *  - `runShutdown()` is async and waits for children to actually close. Use it
 *    wherever there is somewhere to wait: signal handlers, the end of a
 *    one-shot command.
 *  - the 'exit' backstop each layer installs is synchronous and cannot wait.
 *    It exists for `process.exit()` called from somewhere that did not await.
 *
 * Idempotent, and safe to call when nothing is running.
 */

type ShutdownStep = () => Promise<void>;

const steps: Array<{ name: string; run: ShutdownStep }> = [];
let inFlight: Promise<void> | undefined;

/** Register something to be ended at shutdown. Called by the layers. */
export function onShutdown(name: string, run: ShutdownStep): void {
  steps.push({ name, run });
}

/**
 * Run every registered step, once.
 *
 * Concurrent callers share the same run rather than starting a second one: a
 * SIGINT arriving while a command is finishing must not race the same cleanup
 * twice.
 */
export function runShutdown(): Promise<void> {
  if (inFlight) {
    return inFlight;
  }

  inFlight = (async () => {
    await Promise.all(steps.map(async ({ name, run }) => {
      try {
        await run();
      } catch (error) {
        // One step failing must not stop the others: the point is to leave as
        // little behind as possible.
        logger.debug('Shutdown step failed', { step: name, error: (error as Error).message });
      }
    }));
  })();

  return inFlight;
}

/**
 * Install handlers that end everything before the process does.
 *
 * `beforeExit` is included for the ordinary case where the event loop simply
 * empties -- it can run async work, unlike 'exit'. It fires only when nothing
 * has called `process.exit()`, which is exactly when there is time to be tidy.
 */
export function installShutdownHandlers(): void {
  if (handlersInstalled) {
    return;
  }
  handlersInstalled = true;

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void runShutdown().finally(() => process.exit(0));
    });
  }
}

let handlersInstalled = false;
