import { describe, it, expect } from 'vitest'
import type { PosterInfo, PosterSetSummary, SetSource } from '../../electron/ipc/types'
import type { ArtOwner } from '../../electron/services/scheduleUtils'
import {
  completenessScore,
  describeCompleteness,
  keptSeasonsNote,
  missingSeasons,
  planMix,
  postersInGroup,
  setCompleteness,
  setGroups,
  type Completeness,
  type LibrarySeason,
} from './artMix'

function poster(url: string, overrides: Partial<PosterInfo> = {}): PosterInfo
{
  return { title: 'Show', url, source: 'mediux', ...overrides }
}

function set(id: string, source: SetSource, posters: PosterInfo[]): PosterSetSummary
{
  return {
    id,
    source,
    setName: `Set ${id}`,
    uploader: 'someone',
    posterCount: posters.length,
    backdropCount: 0,
    titleCardCount: 0,
    posters,
  }
}

function owner(setKey: string, source: SetSource = 'mediux'): ArtOwner
{
  return { setKey, source }
}

function completeness(overrides: Partial<Completeness> = {}): Completeness
{
  return { seasonsHave: [1, 2, 3, 4], seasonsInLibrary: [1, 2, 3, 4, 5], cards: 38, cardsInLibrary: 52, ...overrides }
}

function range(from: number, to: number): number[]
{
  return Array.from({ length: to - from + 1 }, (_, i) => from + i)
}

const show = poster('show.jpg')
const season1 = poster('s1.jpg', { season: 1 })
const season2 = poster('s2.jpg', { season: 2 })
const card = poster('s1e1.jpg', { season: 1, episode: 1 })
const backdrop = poster('bd.jpg', { season: 'Backdrop' })
const collection = poster('coll.jpg', { isCollection: true })

describe('postersInGroup', () =>
{
  const all = [show, season1, season2, card, backdrop, collection]

  it('keeps the posters whose slot is in the group, in their original order', () =>
  {
    expect(postersInGroup(all, 'poster')).toEqual([show])
    expect(postersInGroup(all, 'seasons')).toEqual([season1, season2])
    expect(postersInGroup(all, 'cards')).toEqual([card])
    expect(postersInGroup(all, 'backdrop')).toEqual([backdrop])
  })

  it('leaves collection art out of every group', () =>
  {
    const collectionSeason = poster('coll-s.jpg', { isCollection: true, season: 1 })
    const collectionCard = poster('coll-c.jpg', { isCollection: true, season: 1, episode: 1 })
    for (const group of ['poster', 'seasons', 'cards', 'backdrop'] as const)
      expect(postersInGroup([collection, collectionSeason, collectionCard], group)).toEqual([])
  })

  it('treats collection-member posters like plain posters', () =>
  {
    const member = poster('member.jpg', { isCollectionMember: true, tmdbId: '7' })
    expect(postersInGroup([member], 'poster')).toEqual([member])
  })

  it('files a cover under the poster group', () =>
  {
    const cover = poster('cover.jpg', { season: 'Cover' })
    expect(postersInGroup([cover], 'poster')).toEqual([cover])
  })

  it('returns nothing for a group the posters do not cover', () =>
  {
    expect(postersInGroup([show], 'cards')).toEqual([])
    expect(postersInGroup([], 'poster')).toEqual([])
  })
})

describe('setGroups', () =>
{
  it('lists the groups a set has art for, in display order', () =>
  {
    expect(setGroups([backdrop, card, season1, show])).toEqual(['poster', 'seasons', 'cards', 'backdrop'])
    expect(setGroups([card, season2])).toEqual(['seasons', 'cards'])
  })

  it('names each group once', () =>
  {
    expect(setGroups([season1, season2, poster('s3.jpg', { season: 3 })])).toEqual(['seasons'])
  })

  it('ignores collection art', () =>
  {
    expect(setGroups([collection])).toEqual([])
    expect(setGroups([collection, poster('coll-s.jpg', { isCollection: true, season: 1 }), card])).toEqual(['cards'])
  })

  it('returns nothing for an empty set', () =>
  {
    expect(setGroups([])).toEqual([])
  })

  it('counts season 0 art as seasons and cards', () =>
  {
    const specials = poster('s0.jpg', { season: 0 })
    const special = poster('s0e1.jpg', { season: 0, episode: 1 })
    expect(setGroups([specials, special])).toEqual(['seasons', 'cards'])
  })
})

describe('planMix', () =>
{
  const mediux1 = set('1', 'mediux', [
    poster('m-show.jpg'),
    poster('m-s1.jpg', { season: 1 }),
    poster('m-s1e1.jpg', { season: 1, episode: 1 }),
    poster('m-s1e2.jpg', { season: 1, episode: 2 }),
    poster('m-coll.jpg', { isCollection: true }),
  ])
  const posterdb5 = set('5', 'posterdb', [
    poster('p-show.jpg', { source: 'posterdb' }),
    poster('p-s1.jpg', { source: 'posterdb', season: 1 }),
    poster('p-bd.jpg', { source: 'posterdb', season: 'Backdrop' }),
  ])
  const sets = [mediux1, posterdb5]
  const urls = (posters: PosterInfo[]) => posters.map(p => p.url)

  it('plans nothing when the chosen set already owns the group', () =>
  {
    expect(planMix({ seasons: 'mediux:1' }, sets, { seasons: owner('mediux:1') })).toEqual([])
  })

  it('plans nothing for an empty mix', () =>
  {
    expect(planMix({}, sets, undefined)).toEqual([])
    expect(planMix({}, sets, { poster: owner('mediux:1') })).toEqual([])
  })

  it('splits a mix into one entry per set, each with its own groups and posters', () =>
  {
    const plan = planMix({ poster: 'posterdb:5', cards: 'mediux:1' }, sets, undefined)

    expect(plan).toHaveLength(2)
    expect(plan[0].set).toBe(posterdb5)
    expect(plan[0].groups).toEqual(['poster'])
    expect(urls(plan[0].posters)).toEqual(['p-show.jpg'])
    expect(plan[1].set).toBe(mediux1)
    expect(plan[1].groups).toEqual(['cards'])
    expect(urls(plan[1].posters)).toEqual(['m-s1e1.jpg', 'm-s1e2.jpg'])
  })

  it('gathers several groups of one set into one entry, in display order', () =>
  {
    const plan = planMix({ cards: 'mediux:1', poster: 'mediux:1', seasons: 'mediux:1' }, sets, undefined)

    expect(plan).toHaveLength(1)
    expect(plan[0].groups).toEqual(['poster', 'seasons', 'cards'])
    expect(urls(plan[0].posters)).toEqual(['m-show.jpg', 'm-s1.jpg', 'm-s1e1.jpg', 'm-s1e2.jpg'])
  })

  it('orders entries by the display order of each one\'s first group, not by the order of the mix', () =>
  {
    const plan = planMix({ backdrop: 'posterdb:5', cards: 'mediux:1' }, sets, undefined)
    expect(plan.map(e => e.set)).toEqual([mediux1, posterdb5])

    const reversed = planMix({ cards: 'mediux:1', backdrop: 'posterdb:5' }, sets, undefined)
    expect(reversed.map(e => e.set)).toEqual([mediux1, posterdb5])
  })

  it('keeps an entry at its first group when the set also holds a later one', () =>
  {
    const plan = planMix({ poster: 'mediux:1', seasons: 'posterdb:5', cards: 'mediux:1' }, sets, undefined)

    expect(plan.map(e => e.set)).toEqual([mediux1, posterdb5])
    expect(plan[0].groups).toEqual(['poster', 'cards'])
    expect(plan[1].groups).toEqual(['seasons'])
  })

  it('leaves out only the groups the chosen set already owns', () =>
  {
    const plan = planMix(
      { poster: 'mediux:1', seasons: 'mediux:1', cards: 'mediux:1' },
      sets,
      { poster: owner('mediux:1'), seasons: owner('posterdb:5', 'posterdb') },
    )

    expect(plan).toHaveLength(1)
    expect(plan[0].groups).toEqual(['seasons', 'cards'])
    expect(urls(plan[0].posters)).toEqual(['m-s1.jpg', 'm-s1e1.jpg', 'm-s1e2.jpg'])
  })

  it('plans a group another set owns, and one nobody owns', () =>
  {
    const plan = planMix({ poster: 'mediux:1', backdrop: 'posterdb:5' }, sets, { poster: owner('posterdb:5', 'posterdb') })

    expect(plan.map(e => e.groups)).toEqual([['poster'], ['backdrop']])
  })

  it('tells sets with one id on both sites apart', () =>
  {
    const twin = set('5', 'mediux', [poster('twin-show.jpg')])
    const bySite = [twin, posterdb5]

    const plan = planMix({ poster: 'posterdb:5' }, bySite, undefined)
    expect(plan).toHaveLength(1)
    expect(plan[0].set).toBe(posterdb5)

    expect(planMix({ poster: 'posterdb:5' }, bySite, { poster: owner('mediux:5') })).toHaveLength(1)
    expect(planMix({ poster: 'mediux:5' }, bySite, { poster: owner('mediux:5') })).toEqual([])
  })

  it('ignores a chosen set that is not in the list', () =>
  {
    expect(planMix({ poster: 'mediux:99' }, sets, undefined)).toEqual([])

    const plan = planMix({ poster: 'mediux:99', backdrop: 'posterdb:5' }, sets, undefined)
    expect(plan).toHaveLength(1)
    expect(plan[0].groups).toEqual(['backdrop'])
  })

  it('leaves out a group the chosen set has no art for', () =>
  {
    expect(planMix({ backdrop: 'mediux:1' }, sets, undefined)).toEqual([])

    const plan = planMix({ poster: 'posterdb:5', cards: 'posterdb:5' }, sets, undefined)
    expect(plan).toHaveLength(1)
    expect(plan[0].groups).toEqual(['poster'])
  })

  it('never includes collection art', () =>
  {
    const plan = planMix({ poster: 'mediux:1' }, sets, undefined)
    expect(urls(plan[0].posters)).toEqual(['m-show.jpg'])
  })

  it('does not change the sets it is given', () =>
  {
    const before = JSON.stringify(sets)
    planMix({ poster: 'mediux:1', backdrop: 'posterdb:5' }, sets, undefined)
    expect(JSON.stringify(sets)).toBe(before)
  })
})

describe('setCompleteness', () =>
{
  const library: LibrarySeason[] = [
    { season: 1, episodes: 10 },
    { season: 2, episodes: 12 },
    { season: 3, episodes: 8 },
  ]

  it('is null when the library has no season to compare against', () =>
  {
    expect(setCompleteness([season1], [])).toBeNull()
    expect(setCompleteness([season1], [{ season: 0, episodes: 4 }])).toBeNull()
  })

  it('lists the set\'s season posters that exist in the library', () =>
  {
    const c = setCompleteness([season1, season2, poster('s9.jpg', { season: 9 })], library)

    expect(c?.seasonsHave).toEqual([1, 2])
    expect(c?.seasonsInLibrary).toEqual([1, 2, 3])
  })

  it('sorts seasons and counts each once', () =>
  {
    const twice = poster('s2-again.jpg', { season: 2 })
    const c = setCompleteness([poster('s3.jpg', { season: 3 }), season2, twice, season1], [...library].reverse())

    expect(c?.seasonsHave).toEqual([1, 2, 3])
    expect(c?.seasonsInLibrary).toEqual([1, 2, 3])
  })

  it('counts only season posters as seasons', () =>
  {
    const c = setCompleteness([show, backdrop, card, poster('cover.jpg', { season: 'Cover' })], library)
    expect(c?.seasonsHave).toEqual([])
  })

  it('counts distinct cards in library seasons, up to the season\'s episode count', () =>
  {
    const cards = [
      poster('a.jpg', { season: 1, episode: 1 }),
      poster('a-again.jpg', { season: 1, episode: 1 }),
      poster('b.jpg', { season: 1, episode: 10 }),
      poster('c.jpg', { season: 1, episode: 11 }),
      poster('d.jpg', { season: 2, episode: 12 }),
      poster('e.jpg', { season: 2, episode: 13 }),
      poster('f.jpg', { season: 9, episode: 1 }),
    ]
    const c = setCompleteness(cards, library)

    expect(c?.cards).toBe(3)
    expect(c?.cardsInLibrary).toBe(30)
  })

  it('counts a card once when two posters carry the same season and episode', () =>
  {
    const c = setCompleteness([poster('x.jpg', { season: 2, episode: 3 }), poster('y.jpg', { season: 2, episode: 3 })], library)
    expect(c?.cards).toBe(1)
  })

  it('counts any episode when the season\'s episode count is unknown', () =>
  {
    const unknown: LibrarySeason[] = [{ season: 1 }, { season: 2 }]
    const c = setCompleteness([
      poster('a.jpg', { season: 1, episode: 1 }),
      poster('b.jpg', { season: 1, episode: 40 }),
      poster('c.jpg', { season: 3, episode: 1 }),
    ], unknown)

    expect(c?.cards).toBe(2)
    expect(c?.cardsInLibrary).toBe(0)
  })

  it('bounds only the seasons whose episode count is known', () =>
  {
    const mixed: LibrarySeason[] = [{ season: 1, episodes: 5 }, { season: 2 }]
    const c = setCompleteness([
      poster('a.jpg', { season: 1, episode: 6 }),
      poster('b.jpg', { season: 2, episode: 6 }),
    ], mixed)

    expect(c?.cards).toBe(1)
    expect(c?.cardsInLibrary).toBe(5)
  })

  it('ignores season 0 everywhere', () =>
  {
    const withSpecials: LibrarySeason[] = [{ season: 0, episodes: 3 }, ...library]
    const c = setCompleteness([
      poster('s0.jpg', { season: 0 }),
      poster('s0e1.jpg', { season: 0, episode: 1 }),
      season1,
    ], withSpecials)

    expect(c?.seasonsHave).toEqual([1])
    expect(c?.seasonsInLibrary).toEqual([1, 2, 3])
    expect(c?.cards).toBe(0)
    expect(c?.cardsInLibrary).toBe(30)
  })

  it('counts nothing for a set whose only art is season 0, though setGroups lists it', () =>
  {
    const specials = [poster('s0.jpg', { season: 0 }), poster('s0e1.jpg', { season: 0, episode: 1 })]
    const c = setCompleteness(specials, [{ season: 0, episodes: 3 }, ...library])

    expect(setGroups(specials)).toEqual(['seasons', 'cards'])
    expect(c?.seasonsHave).toEqual([])
    expect(c?.cards).toBe(0)
    expect(setCompleteness(specials, [{ season: 0, episodes: 3 }])).toBeNull()
  })

  it('ignores collection art', () =>
  {
    const c = setCompleteness([
      poster('cs.jpg', { isCollection: true, season: 1 }),
      poster('cc.jpg', { isCollection: true, season: 1, episode: 1 }),
    ], library)

    expect(c?.seasonsHave).toEqual([])
    expect(c?.cards).toBe(0)
  })

  it('counts a set with no art as having nothing', () =>
  {
    expect(setCompleteness([], library)).toEqual({ seasonsHave: [], seasonsInLibrary: [1, 2, 3], cards: 0, cardsInLibrary: 30 })
  })
})

describe('describeCompleteness', () =>
{
  it('states the seasons a set has against the seasons in the library', () =>
  {
    expect(describeCompleteness(completeness()).seasons).toBe('S1-4 of your S1-5')
  })

  it('says so when the set covers every season', () =>
  {
    expect(describeCompleteness(completeness({ seasonsHave: range(1, 5) })).seasons).toBe('S1-5 of your S1-5')
  })

  it('writes a single season without a range', () =>
  {
    expect(describeCompleteness(completeness({ seasonsHave: [3], seasonsInLibrary: [3] })).seasons).toBe('S3 of your S3')
    expect(describeCompleteness(completeness({ seasonsHave: [3] })).seasons).toBe('S3 of your S1-5')
  })

  it('collapses runs into ranges and writes the S once', () =>
  {
    expect(describeCompleteness(completeness({ seasonsHave: [1, 2, 4] })).seasons).toBe('S1-2, 4 of your S1-5')
    expect(describeCompleteness(completeness({ seasonsHave: [1, 3, 5] })).seasons).toBe('S1, 3, 5 of your S1-5')
    expect(describeCompleteness(completeness({ seasonsHave: [2, 3, 4, 6, 7], seasonsInLibrary: range(1, 7) })).seasons).toBe('S2-4, 6-7 of your S1-7')
  })

  it('writes the library side in the same range format', () =>
  {
    const c = completeness({ seasonsHave: [1, 2], seasonsInLibrary: [1, 2, 4, 5, 6] })
    expect(describeCompleteness(c).seasons).toBe('S1-2 of your S1-2, 4-6')
  })

  it('says there are no season posters when the set has none', () =>
  {
    expect(describeCompleteness(completeness({ seasonsHave: [] })).seasons).toBe('No season posters')
  })

  it('states the cards a set has against the episodes in the library', () =>
  {
    expect(describeCompleteness(completeness()).cards).toBe('38/52 cards')
    expect(describeCompleteness(completeness({ cards: 52 })).cards).toBe('52/52 cards')
  })

  it('keeps "cards" plural for a single card', () =>
  {
    expect(describeCompleteness(completeness({ cards: 1, cardsInLibrary: 10 })).cards).toBe('1/10 cards')
    expect(describeCompleteness(completeness({ cards: 1, cardsInLibrary: 0 })).cards).toBe('1 cards')
  })

  it('says there are no title cards when the set has none for the library\'s seasons', () =>
  {
    expect(describeCompleteness(completeness({ cards: 0 })).cards).toBe('No title cards')
    expect(describeCompleteness(completeness({ cards: 0, cardsInLibrary: 0 })).cards).toBe('No title cards')
  })

  it('gives the card count alone when the library\'s episode counts are unknown', () =>
  {
    expect(describeCompleteness(completeness({ cards: 38, cardsInLibrary: 0 })).cards).toBe('38 cards')
  })
})

describe('completenessScore', () =>
{
  it('adds the share of seasons and the share of cards', () =>
  {
    expect(completenessScore(completeness({ seasonsHave: [1, 2], seasonsInLibrary: [1, 2, 3, 4], cards: 26, cardsInLibrary: 52 }))).toBe(1)
    expect(completenessScore(completeness({ seasonsHave: range(1, 5), cards: 52 }))).toBe(2)
  })

  it('ranks a fuller set above an emptier one', () =>
  {
    const full = completeness({ seasonsHave: range(1, 5), cards: 52 })
    const partial = completeness()
    const bare = completeness({ seasonsHave: [], cards: 0 })

    expect(completenessScore(full)).toBeGreaterThan(completenessScore(partial))
    expect(completenessScore(partial)).toBeGreaterThan(completenessScore(bare))
    expect(completenessScore(bare)).toBe(0)
  })

  it('does not divide by zero when the library has no seasons or episode counts', () =>
  {
    const empty = completeness({ seasonsHave: [], seasonsInLibrary: [], cards: 0, cardsInLibrary: 0 })
    expect(completenessScore(empty)).toBe(0)

    const unknown = completeness({ seasonsHave: [1], seasonsInLibrary: [1], cards: 5, cardsInLibrary: 0 })
    expect(completenessScore(unknown)).toBe(6)
  })
})

describe('missingSeasons', () =>
{
  it('lists the library seasons the set lacks, ascending', () =>
  {
    expect(missingSeasons(completeness({ seasonsHave: [1, 2, 4], seasonsInLibrary: range(1, 5) }))).toEqual([3, 5])
    expect(missingSeasons(completeness({ seasonsHave: [], seasonsInLibrary: [3, 1, 2] }))).toEqual([1, 2, 3])
  })

  it('is empty when the set covers every season', () =>
  {
    expect(missingSeasons(completeness({ seasonsHave: range(1, 5), seasonsInLibrary: range(1, 5) }))).toEqual([])
  })

  it('never lists season 0', () =>
  {
    expect(missingSeasons(completeness({ seasonsHave: [], seasonsInLibrary: [0, 1] }))).toEqual([1])
  })

  it('works from a set\'s completeness end to end', () =>
  {
    const c = setCompleteness([season1, season2], [{ season: 0, episodes: 2 }, { season: 1, episodes: 8 }, { season: 2, episodes: 8 }, { season: 3, episodes: 8 }])
    expect(c && missingSeasons(c)).toEqual([3])
  })
})

describe('keptSeasonsNote', () =>
{
  it('says nothing when no season is left out', () =>
  {
    expect(keptSeasonsNote([])).toBeUndefined()
  })

  it('names a single season', () =>
  {
    expect(keptSeasonsNote([5])).toBe('Season 5 keeps its current poster')
  })

  it('lists a few seasons', () =>
  {
    expect(keptSeasonsNote([5, 6])).toBe('Seasons 5 and 6 keep their current posters')
    expect(keptSeasonsNote([2, 5, 6])).toBe('Seasons 2, 5 and 6 keep their current posters')
  })

  it('shortens three or more seasons in a row to a range', () =>
  {
    expect(keptSeasonsNote(range(3, 12))).toBe('Seasons 3-12 keep their current posters')
    expect(keptSeasonsNote([1, 4, 5, 6, 9])).toBe('Seasons 1, 4-6 and 9 keep their current posters')
  })
})
