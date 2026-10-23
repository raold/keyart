import { describe, it, expect, afterEach, vi } from 'vitest'
import { createShutdown } from '../../server/shutdown'

afterEach(() =>
{
  vi.useRealTimers()
})

describe('createShutdown', () =>
{
  it('stops the scheduler, closes the server, then exits 0', async () =>
  {
    const calls: string[] = []
    const shutdown = createShutdown({
      stopScheduler: () => { calls.push('stopScheduler') },
      closeServer: async () => { calls.push('closeServer') },
      exit: code => { calls.push(`exit ${code}`) },
      log: () => { calls.push('log') },
    })

    await shutdown()

    expect(calls).toEqual(['log', 'stopScheduler', 'closeServer', 'exit 0'])
  })

  it('a second call does not run the steps again', async () =>
  {
    const stopScheduler = vi.fn()
    const closeServer = vi.fn(async () => {})
    const exit = vi.fn()
    const shutdown = createShutdown({ stopScheduler, closeServer, exit, log: vi.fn() })

    const first = shutdown()
    const second = shutdown()
    await Promise.all([first, second])
    await shutdown()

    expect(second).toBe(first)
    expect(stopScheduler).toHaveBeenCalledTimes(1)
    expect(closeServer).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('exits 0 when closing the server hangs past the timeout', async () =>
  {
    vi.useFakeTimers()
    const exit = vi.fn()
    const log = vi.fn()
    const shutdown = createShutdown({
      stopScheduler: vi.fn(),
      closeServer: () => new Promise<void>(() => {}),
      exit,
      log,
      timeoutMs: 5000,
    })

    const done = shutdown()
    await vi.advanceTimersByTimeAsync(4999)
    expect(exit).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await done

    expect(exit).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(0)
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('5000'))
  })

  it('uses a 5 second timeout by default', async () =>
  {
    vi.useFakeTimers()
    const exit = vi.fn()
    const shutdown = createShutdown({
      stopScheduler: vi.fn(),
      closeServer: () => new Promise<void>(() => {}),
      exit,
      log: vi.fn(),
    })

    const done = shutdown()
    await vi.advanceTimersByTimeAsync(4999)
    expect(exit).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('exits 1 when closing the server fails', async () =>
  {
    const exit = vi.fn()
    const log = vi.fn()
    const shutdown = createShutdown({
      stopScheduler: vi.fn(),
      closeServer: async () => { throw new Error('close failed') },
      exit,
      log,
    })

    await shutdown()

    expect(exit).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(1)
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('close failed'))
  })

  it('exits 1 when stopping the scheduler throws', async () =>
  {
    const closeServer = vi.fn(async () => {})
    const exit = vi.fn()
    const shutdown = createShutdown({
      stopScheduler: () => { throw new Error('stop failed') },
      closeServer,
      exit,
      log: vi.fn(),
    })

    await shutdown()

    expect(exit).toHaveBeenCalledWith(1)
  })
})
