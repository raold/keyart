import type { PosterInfo, PosterSetSummary } from '../../electron/ipc/types'
import { ART_GROUPS, posterSlot, slotGroup, type ArtGroup, type ArtOwner } from '../../electron/services/scheduleUtils'
import { setKey } from './posterGroups'

/**
 * Picks a show's art out of a set, one art group at a time. Collection art is
 * never part of a group: it targets a Plex collection, not the show.
 *
 * @param posters - Posters from one set.
 * @param group - The art group to keep.
 * @returns The posters filling that group, in their original order.
 */
export function postersInGroup(posters: PosterInfo[], group: ArtGroup): PosterInfo[] {
  return posters.filter(p => !p.isCollection && slotGroup(posterSlot(p)) === group)
}

/**
 * Names the art groups a set has something for.
 *
 * @param posters - Posters from one set.
 * @returns Each group the set covers once, in display order.
 */
export function setGroups(posters: PosterInfo[]): ArtGroup[] {
  return ART_GROUPS.filter(g => postersInGroup(posters, g).length > 0)
}

/** What each art group is called on screen. */
export const GROUP_LABEL: Record<ArtGroup, string> = {
  poster: 'Poster',
  seasons: 'Seasons',
  cards: 'Title cards',
  backdrop: 'Backdrop',
}

/** The set picked for each art group, as the set's {@link setKey}. */
export type ArtMix = Partial<Record<ArtGroup, string>>

/**
 * Works out what applying a mix would change on a show.
 *
 * A group the chosen set already owns is left out, and so is a group the chosen
 * set has no art for. A chosen set missing from the list is ignored.
 *
 * @param mix - The set picked for each group.
 * @param sets - The sets on offer for the show.
 * @param owners - Which set owns each group on the show now; undefined when none does.
 * @returns One entry per set with a changed group, ordered by the display order of its first group,
 * each with its changed groups in display order and the posters filling them.
 */
export function planMix(
  mix: ArtMix,
  sets: PosterSetSummary[],
  owners: Partial<Record<ArtGroup, ArtOwner>> | undefined,
): { set: PosterSetSummary; groups: ArtGroup[]; posters: PosterInfo[] }[] {
  const plan = new Map<string, { set: PosterSetSummary; groups: ArtGroup[]; posters: PosterInfo[] }>()
  for (const group of ART_GROUPS) {
    const key = mix[group]
    if (!key || owners?.[group]?.setKey === key) continue
    const set = sets.find(s => setKey(s) === key)
    if (!set) continue
    const posters = postersInGroup(set.posters, group)
    if (!posters.length) continue
    const entry = plan.get(key) ?? { set, groups: [], posters: [] }
    entry.groups.push(group)
    entry.posters.push(...posters)
    plan.set(key, entry)
  }
  return [...plan.values()]
}

/** A season in the user's Plex library. */
export interface LibrarySeason {
  season: number
  /** Episodes Plex has for the season; undefined when unknown. */
  episodes?: number
}

/** How much of a show's library a set covers. */
export interface Completeness {
  /** Seasons the set has a poster for that exist in the library, ascending. */
  seasonsHave: number[]
  /** Seasons in the library, ascending, without season 0. */
  seasonsInLibrary: number[]
  /** Title cards the set has for episodes that exist in the library. */
  cards: number
  /** Episodes in the library across those seasons; 0 when the counts are unknown. */
  cardsInLibrary: number
}

/**
 * Measures a set against the seasons and episodes in the library. Season 0
 * (specials) is ignored throughout, and so are seasons and episodes Plex lacks.
 *
 * @param posters - Posters from one set.
 * @param library - The seasons in the library.
 * @returns The measure, or null when the library has no season to compare against.
 */
export function setCompleteness(posters: PosterInfo[], library: LibrarySeason[]): Completeness | null {
  const episodes = new Map<number, number | undefined>()
  for (const { season, episodes: count } of library) if (season >= 1) episodes.set(season, count)
  if (!episodes.size) return null

  const seasonsHave = new Set<number>()
  for (const p of postersInGroup(posters, 'seasons'))
    if (typeof p.season === 'number' && episodes.has(p.season)) seasonsHave.add(p.season)

  const cards = new Set<string>()
  for (const p of postersInGroup(posters, 'cards')) {
    if (typeof p.season !== 'number' || p.episode == null || !episodes.has(p.season)) continue
    const count = episodes.get(p.season)
    if (count === undefined || p.episode <= count) cards.add(posterSlot(p))
  }

  return {
    seasonsHave: [...seasonsHave].sort((a, b) => a - b),
    seasonsInLibrary: [...episodes.keys()].sort((a, b) => a - b),
    cards: cards.size,
    cardsInLibrary: [...episodes.values()].reduce<number>((sum, count) => sum + (count ?? 0), 0),
  }
}

/**
 * Writes season numbers as ranges with a single leading S.
 *
 * @param seasons - Season numbers, ascending and distinct.
 * @returns For example "S1-2, 4".
 */
function seasonRanges(seasons: number[]): string {
  const runs: string[] = []
  for (let i = 0; i < seasons.length; i++) {
    let end = i
    while (seasons[end + 1] === seasons[end] + 1) end++
    runs.push(end > i ? `${seasons[i]}-${seasons[end]}` : `${seasons[i]}`)
    i = end
  }
  return `S${runs.join(', ')}`
}

/**
 * Words a set's completeness for its card.
 *
 * @param c - The set's {@link setCompleteness}.
 * @returns A line for seasons ("S1-4 of your S1-5") and one for cards ("38/52 cards").
 */
export function describeCompleteness(c: Completeness): { seasons: string; cards: string } {
  const seasons = c.seasonsHave.length
    ? `${seasonRanges(c.seasonsHave)} of your ${seasonRanges(c.seasonsInLibrary)}`
    : 'No season posters'
  let cards = `${c.cards}/${c.cardsInLibrary} cards`
  if (c.cards === 0) cards = 'No title cards'
  else if (c.cardsInLibrary === 0) cards = `${c.cards} cards`
  return { seasons, cards }
}

/**
 * Scores a set for the "Most complete" sort: its share of the library's
 * seasons plus its share of the library's episodes, so up to 2.
 *
 * @param c - The set's {@link setCompleteness}.
 * @returns The score; higher is more complete.
 */
export function completenessScore(c: Completeness): number {
  return c.seasonsHave.length / Math.max(1, c.seasonsInLibrary.length) + c.cards / Math.max(1, c.cardsInLibrary)
}

/**
 * Orders sets for the "Most complete" sort: highest {@link completenessScore}
 * first, sets with no completeness last, ties and unscored sets in the order given.
 *
 * @param items - The sets, in their current order. Not modified.
 * @param completenessOf - Looks up a set's {@link setCompleteness}.
 * @returns A new array.
 */
export function sortByCompleteness<T>(items: T[], completenessOf: (item: T) => Completeness | null): T[] {
  return items
    .map(item => {
      const c = completenessOf(item)
      return { item, score: c ? completenessScore(c) : null }
    })
    .sort((a, b) => {
      if (a.score === null || b.score === null) return (a.score === null ? 1 : 0) - (b.score === null ? 1 : 0)
      return b.score - a.score
    })
    .map(entry => entry.item)
}

/**
 * Names the library seasons a set has no poster for.
 *
 * @param c - The set's {@link setCompleteness}.
 * @returns The season numbers, ascending, without season 0.
 */
export function missingSeasons(c: Completeness): number[] {
  const have = new Set(c.seasonsHave)
  return c.seasonsInLibrary.filter(s => s >= 1 && !have.has(s)).sort((a, b) => a - b)
}

/**
 * Tells which seasons a mix leaves alone because the chosen set has no poster
 * for them. Three or more seasons in a row are written as a range.
 *
 * @param seasons - The seasons left out, ascending and distinct (see {@link missingSeasons}).
 * @returns For example "Season 5 keeps its current poster", or undefined when none is left out.
 */
export function keptSeasonsNote(seasons: number[]): string | undefined {
  if (!seasons.length) return undefined
  if (seasons.length === 1) return `Season ${seasons[0]} keeps its current poster`
  const parts: string[] = []
  for (let i = 0; i < seasons.length; i++) {
    let end = i
    while (seasons[end + 1] === seasons[end] + 1) end++
    if (end - i >= 2) {
      parts.push(`${seasons[i]}-${seasons[end]}`)
      i = end
    } else parts.push(`${seasons[i]}`)
  }
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  return `Seasons ${list} keep their current posters`
}
