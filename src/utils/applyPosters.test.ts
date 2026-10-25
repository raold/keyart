import { describe, it, expect, vi, afterEach } from 'vitest'
import type { PosterInfo, UploadRes } from '../../electron/ipc/types'
import { applyError, applyPosters } from './applyPosters'
import { ALL_TYPES, type FileType } from './posterGroups'

function poster(overrides: Partial<PosterInfo>): PosterInfo
{
  return { title: 'Show', url: 'https://example.com/a.jpg', source: 'mediux', ...overrides }
}

function stubUpload(results: Record<string, UploadRes | Error>): ReturnType<typeof vi.fn>
{
  const uploadPoster = vi.fn(async (_key: string, url: string) =>
  {
    const res = results[url]
    if (res instanceof Error) throw res
    return res
  })
  vi.stubGlobal('window', { api: { plex: { uploadPoster } } })
  return uploadPoster
}

afterEach(() => { vi.unstubAllGlobals() })

describe('applyPosters', () =>
{
  it('counts a season missing from Plex as skipped, not failed', async () =>
  {
    stubUpload({
      'https://example.com/ok.jpg': { success: true },
      'https://example.com/gone.jpg': { success: false, skipped: true },
      'https://example.com/bad.jpg': { success: false, error: 'boom' },
    })
    const progress: Array<[number, number]> = []

    const res = await applyPosters('42', [
      poster({ url: 'https://example.com/ok.jpg', season: 1 }),
      poster({ url: 'https://example.com/gone.jpg', season: 9 }),
      poster({ url: 'https://example.com/bad.jpg', season: 2 }),
    ], new Set(ALL_TYPES), (done, total) => { progress.push([done, total]) })

    expect(res).toEqual({
      done: 1,
      failed: 1,
      skipped: 1,
      total: 3,
      appliedUrls: ['https://example.com/ok.jpg'],
      appliedSlots: ['s1'],
      lastError: 'boom',
    })
    expect(progress).toEqual([[1, 3], [1, 3], [1, 3]])
  })

  it('leaves lastError unset when every miss was a skip', async () =>
  {
    stubUpload({ 'https://example.com/gone.jpg': { success: false, skipped: true } })

    const res = await applyPosters('42', [poster({ url: 'https://example.com/gone.jpg', season: 9 })], new Set(ALL_TYPES), () => {})

    expect(res.skipped).toBe(1)
    expect(res.failed).toBe(0)
    expect(res.lastError).toBeUndefined()
  })

  it('counts a rejected upload as failed with its message', async () =>
  {
    stubUpload({ 'https://example.com/a.jpg': new Error('network down') })

    const res = await applyPosters('42', [poster({})], new Set(ALL_TYPES), () => {})

    expect(res).toMatchObject({ done: 0, failed: 1, skipped: 0, total: 1, lastError: 'network down' })
  })

  it('does not send posters of a disabled type', async () =>
  {
    const uploadPoster = stubUpload({
      'https://example.com/p.jpg': { success: true },
      'https://example.com/b.jpg': { success: true },
    })
    const enabled = new Set<FileType>(['poster'])

    const res = await applyPosters('42', [
      poster({ url: 'https://example.com/p.jpg' }),
      poster({ url: 'https://example.com/b.jpg', season: 'Backdrop' }),
    ], enabled, () => {})

    expect(uploadPoster).toHaveBeenCalledTimes(1)
    expect(uploadPoster.mock.calls[0][1]).toBe('https://example.com/p.jpg')
    expect(res).toMatchObject({ done: 1, failed: 0, skipped: 0, total: 1 })
  })
})

describe('applyError', () =>
{
  it('is undefined when nothing went wrong', () =>
  {
    expect(applyError(0)).toBeUndefined()
    expect(applyError(0, undefined, 0)).toBeUndefined()
  })

  it('reports skipped seasons on their own', () =>
  {
    expect(applyError(0, undefined, 6)).toBe('6 skipped: not in your library')
  })

  it('orders failures, skips, then the history error', () =>
  {
    expect(applyError(2, 'disk full', 1)).toBe('2 failed · 1 skipped: not in your library · history not saved: disk full')
  })

  it('keeps the old text when nothing was skipped', () =>
  {
    expect(applyError(3)).toBe('3 failed')
    expect(applyError(0, 'disk full')).toBe('history not saved: disk full')
  })
})
