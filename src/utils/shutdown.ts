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
 * Concurrent callers share one run; a later call runs again. Safe to call when
 * nothing is running.
 */

type ShutdownStep = () => Promise<void>;

const steps: Array<{ name: string; run: ShutdownStep }> = [];
let inFlight: Promise<void> | undefined;
let generation = 0;

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

  const run = (async () => {
    // A snapshot: a step registered while this one is running belongs to the
    // next call, not to a list being iterated.
    const current = [...steps];

    await Promise.all(current.map(async ({ name, run: step }) => {
      try {
        await step();
      } catch (error) {
        // One step failing must not stop the others: the point is to leave as
        // little behind as possible.
        logger.debug('Shutdown step failed', { step: name, error: (error as Error).message });
      }
    }));
  })();

  // Shared only while it is running. Holding it forever made the *first* call
  // the only one that ever did anything -- and for `cgmb serve` the first call
  // happens at startup, before a single child exists, so a server that ran for
  // an hour and then took a SIGINT was handed a completed promise and cleaned
  // up nothing. Layers register lazily on first spawn, so most of them had not
  // even been registered when that empty run completed.
  //
  // The generation counter, rather than comparing against the promise itself:
  // that would have to be referenced from inside its own .finally, before its
  // declaration -- which is exactly the temporal dead zone that bit the
  // cancellation wiring two rounds ago.
  generation += 1;
  const mine = generation;

  inFlight = run.finally(() => {
    if (generation === mine) {
      inFlight = undefined;
    }
  });

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

  // The ordinary end of a one-shot command: the event loop has emptied, so
  // there is nothing left to do but tidy up -- and 'beforeExit', unlike 'exit',
  // can wait for that.
  //
  // This replaced an unconditional `await runShutdown()` after parseAsync
  // returned. That looked equivalent and was not: `serve` returns from its
  // action as soon as the transport is connected, so the call landed while the
  // server was healthy and ran every step against it -- including the one that
  // stops the server. Measured: `cgmb serve` exited 0 without answering a
  // single request. A long-running server never empties its loop, so this never
  // fires for one.
  process.on('beforeExit', () => {
    void runShutdown();
  });
}

let handlersInstalled = false;
