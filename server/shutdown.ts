export interface ShutdownDeps {
  stopScheduler: () => void
  closeServer: () => Promise<void>
  exit: (code: number) => void
  log: (msg: string) => void
  /** How long to wait for the server to close before exiting anyway. Defaults to 5000. */
  timeoutMs?: number
}

/**
 * Builds the handler for SIGTERM and SIGINT: stops the scheduler, closes the
 * server (waiting at most `timeoutMs`), then exits 0, or 1 if a step fails.
 * Only the first call does any work; later calls return the same promise.
 *
 * @param deps - The steps to run and the process hooks to run them with.
 * @returns A function that starts (or joins) the shutdown.
 */
export function createShutdown(deps: ShutdownDeps): () => Promise<void> {
  const { stopScheduler, closeServer, exit, log, timeoutMs = 5000 } = deps
  let running: Promise<void> | null = null

  async function run(): Promise<void> {
    log('Shutting down')
    let code = 0
    let timer: NodeJS.Timeout | undefined
    try {
      stopScheduler()
      const timedOut = new Promise<void>(resolve => {
        timer = setTimeout(() => {
          log(`Server did not close within ${timeoutMs} ms - exiting anyway`)
          resolve()
        }, timeoutMs)
      })
      await Promise.race([closeServer(), timedOut])
    } catch (err) {
      log(`Shutdown failed: ${err instanceof Error ? err.message : String(err)}`)
      code = 1
    } finally {
      clearTimeout(timer)
    }
    exit(code)
  }

  return () => {
    if (!running) running = run()
    return running
  }
}
