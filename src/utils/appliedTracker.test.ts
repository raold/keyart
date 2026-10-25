import { describe, it, expect, vi, afterEach } from 'vitest'
import type { AppliedRecord } from '../../electron/ipc/types'
import { appliedKey, loadAppliedIndex } from './appliedTracker'

function rec(overrides: Partial<AppliedRecord>): AppliedRecord
{
  return { itemKey: 'A', title: 'Show', type: 'show', source: 'mediux', appliedAt: '2026-10-01T00:00:00.000Z', ...overrides }
}

function stubHistory(appliedPosters: AppliedRecord[]): void
{
  vi.stubGlobal('window', { api: { config: { get: async () => ({ appliedPosters }) } } })
}

afterEach(() => { vi.unstubAllGlobals() })

describe('loadAppliedIndex', () =>
{
  it('keys sets by site, so MediUX and ThePosterDB sets with one id stay apart', async () =>
  {
    stubHistory([
      rec({ itemKey: 'A', setId: '42', source: 'mediux', posterUrls: ['m1'], appliedAt: '2026-10-01T00:00:00.000Z' }),
      rec({ itemKey: 'A', setId: '42', source: 'posterdb', posterUrls: ['p1'], appliedAt: '2026-10-02T00:00:00.000Z' }),
      rec({ itemKey: 'B', title: 'Manual', posterUrls: ['manual'] }),
    ])

    const idx = await loadAppliedIndex()

    expect([...idx.setKeys].sort()).toEqual(['mediux:42', 'posterdb:42'])
    expect(idx.currentByItem.get('A')).toBe('posterdb:42')
    expect(idx.currentByItem.has('B')).toBe(false)
    expect(idx.currentPosterUrls.has('p1')).toBe(true)
    expect(idx.currentPosterUrls.has('m1')).toBe(false)
    expect(idx.currentPosterUrls.has('manual')).toBe(true)
    expect([...idx.posterUrls].sort()).toEqual(['m1', 'manual', 'p1'])
    expect(idx.titles.has(appliedKey('Show'))).toBe(true)
    expect(idx.titles.has(appliedKey('Manual'))).toBe(true)
  })

  it('picks the newest record per item regardless of list order', async () =>
  {
    stubHistory([
      rec({ itemKey: 'A', setId: '7', source: 'posterdb', appliedAt: '2026-10-03T00:00:00.000Z' }),
      rec({ itemKey: 'A', setId: '8', source: 'mediux', appliedAt: '2026-10-01T00:00:00.000Z' }),
    ])

    const idx = await loadAppliedIndex()

    expect(idx.currentByItem.get('A')).toBe('posterdb:7')
  })

  it('names the set that owns each art group, so a show can mix two sets', async () =>
  {
    stubHistory([
      rec({ itemKey: 'A', setId: '1', source: 'mediux', uploader: 'alpha', thumb: 't1', slots: ['poster', 's1'], groups: ['poster', 'seasons'], appliedAt: '2026-10-01T00:00:00.000Z' }),
      rec({ itemKey: 'A', setId: '2', source: 'posterdb', uploader: 'beta', slots: ['s1e1', 's1e2'], groups: ['cards'], appliedAt: '2026-10-02T00:00:00.000Z' }),
    ])

    const idx = await loadAppliedIndex()

    const owners = idx.owners.get('A')
    expect(owners?.poster).toMatchObject({ setKey: 'mediux:1', source: 'mediux', setId: '1', uploader: 'alpha', thumb: 't1' })
    expect(owners?.seasons?.setKey).toBe('mediux:1')
    expect(owners?.cards).toMatchObject({ setKey: 'posterdb:2', source: 'posterdb', uploader: 'beta' })
    expect(owners?.backdrop).toBeUndefined()
    expect(idx.owners.has('B')).toBe(false)
  })

  it('is empty without history', async () =>
  {
    vi.stubGlobal('window', { api: { config: { get: async () => ({}) } } })

    const idx = await loadAppliedIndex()

    expect(idx.setKeys.size).toBe(0)
    expect(idx.titles.size).toBe(0)
    expect(idx.posterUrls.size).toBe(0)
    expect(idx.currentByItem.size).toBe(0)
    expect(idx.currentPosterUrls.size).toBe(0)
    expect(idx.owners.size).toBe(0)
  })
})
