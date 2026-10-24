import { describe, it, expect } from 'vitest'
import type { AppliedRecord } from '../../electron/ipc/types'
import { applyGridQuery, historyKeysFor, lightComparator, needsHistoryOnly, plexSortParam, toLightItem, withEpisodeOrder, type LightItem } from '../../electron/services/libraryGrid'
import { appliedByItem, creatorSyncUrl, scheduleCoverage } from '../../electron/services/scheduleUtils'

function light(key: string, title: string, extra: Partial<LightItem> = {}): LightItem
{
  return { key, title, titleSort: title.toLowerCase(), addedAt: 0, lastViewedAt: 0, ...extra }
}

function rec(itemKey: string, overrides: Partial<AppliedRecord> = {}): AppliedRecord
{
  return { itemKey, title: 'Show', type: 'show', source: 'mediux', appliedAt: '2026-10-01T00:00:00.000Z', ...overrides }
}

const byItem = appliedByItem([rec('2', { uploader: 'willtong93', setId: 'a' }), rec('3', { uploader: 'other', setId: 'b' })])
const coverage = scheduleCoverage([{ id: 'j', name: 'j', urls: [creatorSyncUrl('willtong93')], cronExpr: '0 3 * * *', enabled: true }])
const pool = [
  light('1', 'Alpha', { year: 2020, addedAt: 30, lastViewedAt: 1 }),
  light('2', 'Bravo', { year: 2018, addedAt: 10, lastViewedAt: 3 }),
  light('3', 'Charlie', { year: 2022, addedAt: 20, lastViewedAt: 2 }),
]

describe('toLightItem', () =>
{
  it('keeps only what filtering and sorting need', () =>
  {
    expect(toLightItem({ ratingKey: 7, title: 'The Show', titleSort: 'Show, The', year: 2001, thumb: '/t', addedAt: 5, lastViewedAt: 'x', Role: [{}] }))
      .toEqual({ key: '7', title: 'The Show', titleSort: 'show, the', year: 2001, thumb: '/t', addedAt: 5, lastViewedAt: 0 })
  })
})

describe('lightComparator', () =>
{
  it('orders by each sort field in either direction with a title tiebreak', () =>
  {
    const ids = (sort: Parameters<typeof lightComparator>[0], dir: Parameters<typeof lightComparator>[1]) => [...pool].sort(lightComparator(sort, dir)).map(i => i.key)
    expect(ids('title', 'asc')).toEqual(['1', '2', '3'])
    expect(ids('title', 'desc')).toEqual(['3', '2', '1'])
    expect(ids('recentlyAdded', 'desc')).toEqual(['1', '3', '2'])
    expect(ids('year', 'asc')).toEqual(['2', '1', '3'])
    expect(ids('lastPlayed', 'desc')).toEqual(['2', '3', '1'])
    expect([light('b', 'Same', { year: 1 }), light('a', 'Same', { year: 1 })].sort(lightComparator('year', 'asc')).map(i => i.key)).toEqual(['b', 'a'])
  })

  it('orders shows by when their last episode was added, newest first when descending', () =>
  {
    const shows = withEpisodeOrder(pool, ['3', '1'])
    expect([...shows].sort(lightComparator('lastEpisodeAdded', 'desc')).map(i => i.key)).toEqual(['3', '1', '2'])
    expect([...shows].sort(lightComparator('lastEpisodeAdded', 'asc')).map(i => i.key)).toEqual(['2', '1', '3'])
  })

  it('falls back to date added for items without an episode order', () =>
  {
    expect([...pool].sort(lightComparator('lastEpisodeAdded', 'desc')).map(i => i.key)).toEqual(['1', '3', '2'])
  })
})

describe('withEpisodeOrder', () =>
{
  it('ranks items by their place in Plex\'s order and leaves the pool alone', () =>
  {
    expect(withEpisodeOrder(pool, ['3', '1']).map(i => [i.key, i.episodeOrder])).toEqual([['1', 1], ['2', 0], ['3', 2]])
    expect(pool.every(i => i.episodeOrder === undefined)).toBe(true)
  })
})

describe('plexSortParam', () =>
{
  it('maps each sort to its Plex field', () =>
  {
    expect(plexSortParam('recentlyAdded', 'desc', 'movie')).toBe('addedAt:desc')
    expect(plexSortParam(undefined, undefined, 'movie')).toBe('titleSort:asc')
    expect(plexSortParam('lastEpisodeAdded', 'desc', 'show')).toBe('episode.addedAt:desc')
  })

  it('sorts movies by date added when asked for the last episode', () =>
  {
    expect(plexSortParam('lastEpisodeAdded', 'desc', 'movie')).toBe('addedAt:desc')
  })
})

describe('history-only filters', () =>
{
  it('answers applied filters from history keys alone', () =>
  {
    expect(needsHistoryOnly(undefined)).toBe(false)
    expect(needsHistoryOnly({ kind: 'none' })).toBe(false)
    expect(needsHistoryOnly({ kind: 'applied' })).toBe(true)
    expect(historyKeysFor({ kind: 'applied' }, byItem, coverage)).toEqual(['2', '3'])
    expect(historyKeysFor({ kind: 'unscheduled' }, byItem, coverage)).toEqual(['3'])
    expect(historyKeysFor({ kind: 'uploader', uploader: 'Willtong93' }, byItem, coverage)).toEqual(['2'])
  })
})

describe('applyGridQuery', () =>
{
  const base = { libraryType: 'show' as const, byItem, coverage }

  const showStatus = new Map<string, 'continuing' | 'ended'>([['1', 'ended'], ['2', 'continuing'], ['3', 'ended']])

  it('filters by art, status, and search, then sorts, without touching the pool', () =>
  {
    const before = pool.map(i => i.key)
    expect(applyGridQuery(pool, { ...base, artFilter: { kind: 'none' } }).map(i => i.key)).toEqual(['1'])
    expect(applyGridQuery(pool, { ...base, artFilter: { kind: 'applied' }, sort: 'title', sortDir: 'desc' }).map(i => i.key)).toEqual(['3', '2'])
    expect(applyGridQuery(pool, { ...base, status: 'continuing', showStatus }).map(i => i.key)).toEqual(['2'])
    expect(applyGridQuery(pool, { ...base, status: 'ended', showStatus }).map(i => i.key)).toEqual(['1', '3'])
    expect(applyGridQuery(pool, { ...base, artFilter: { kind: 'applied' }, status: 'ended', showStatus }).map(i => i.key)).toEqual(['3'])
    expect(applyGridQuery(pool, { ...base, search: 'AR' }).map(i => i.key)).toEqual(['3'])
    expect(pool.map(i => i.key)).toEqual(before)
  })

  it('ignores the status filter for movie libraries', () =>
  {
    expect(applyGridQuery(pool, { ...base, libraryType: 'movie', status: 'continuing', showStatus })).toHaveLength(3)
  })
})
