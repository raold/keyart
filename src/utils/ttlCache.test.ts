import { describe, it, expect, vi } from 'vitest'
import { ttlCached } from '../../electron/services/ttlCache'

describe('ttlCached', () =>
{
  it('fetches once within the TTL', async () =>
  {
    let t = 0
    const fetch = vi.fn(async () => 'a')
    const get = ttlCached(fetch, 1000, () => t)

    expect(await get()).toBe('a')
    t = 999
    expect(await get()).toBe('a')

    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('fetches again after the TTL', async () =>
  {
    let t = 0
    const fetch = vi.fn(async () => `call ${fetch.mock.calls.length}`)
    const get = ttlCached(fetch, 1000, () => t)

    expect(await get()).toBe('call 1')
    t = 1000
    expect(await get()).toBe('call 2')

    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('shares one in-flight fetch between concurrent callers', async () =>
  {
    let release!: (value: string) => void
    const fetch = vi.fn(() => new Promise<string>(resolve => { release = resolve }))
    const get = ttlCached(fetch, 1000, () => 0)

    const first = get()
    const second = get()
    release('done')

    expect(await first).toBe('done')
    expect(await second).toBe('done')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('caches a failed (null) result until the TTL ends', async () =>
  {
    let t = 0
    const results = [null, 'recovered']
    const fetch = vi.fn(async () => results.shift() ?? null)
    const get = ttlCached(fetch, 1000, () => t)

    expect(await get()).toBeNull()
    t = 500
    expect(await get()).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)

    t = 1000
    expect(await get()).toBe('recovered')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
