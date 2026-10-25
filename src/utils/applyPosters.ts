import type { PosterInfo, UploadRes } from '../../electron/ipc/types'
import { posterSlot } from '../../electron/services/scheduleUtils'
import { posterFileType, type FileType } from './posterGroups'

/** Apply progress for a single set. */
export interface ApplyState { status: 'idle' | 'applying' | 'done' | 'error'; done: number; total: number; skipped?: number; error?: string }

/**
 * Error text for a finished apply: upload failures first, then posters whose
 * season or episode is not in Plex, then a failure to save the history that
 * drives the Applied badges and filters.
 *
 * @param failed - Posters that failed to upload.
 * @param historyError - Why the history write failed, if it did.
 * @param skipped - Posters skipped because their season or episode is not in Plex.
 * @returns The text, or undefined when everything went through.
 */
export function applyError(failed: number, historyError?: string, skipped?: number): string | undefined {
  const parts: string[] = []
  if (failed) parts.push(`${failed} failed`)
  if (skipped) parts.push(`${skipped} skipped: not in your library`)
  if (historyError) parts.push(`history not saved: ${historyError}`)
  return parts.length ? parts.join(' · ') : undefined
}

/**
 * Applies a set's posters to a Plex target, routing each by season/episode.
 *
 * @param targetKey - Plex ratingKey to apply onto.
 * @param posters - Candidate posters; filtered by the enabled types.
 * @param enabled - File types the user has switched on.
 * @param onProgress - Called after each poster with done/total counts.
 * @returns Done/failed/skipped counts, the URLs and slots actually applied, and the last error.
 */
export async function applyPosters(
  targetKey: string,
  posters: PosterInfo[],
  enabled: Set<FileType>,
  onProgress: (done: number, total: number) => void,
): Promise<{ done: number; failed: number; skipped: number; total: number; appliedUrls: string[]; appliedSlots: string[]; lastError?: string }> {
  const list = posters.filter(p => enabled.has(posterFileType(p)))
  let done = 0, failed = 0, skipped = 0
  const appliedUrls: string[] = []
  const appliedSlots: string[] = []
  let lastError: string | undefined
  for (const p of list) {
    try {
      const res = await window.api.plex.uploadPoster(targetKey, p.url, p.source, p.season, p.episode, p.isCollection) as UploadRes
      if (res.success) { done++; appliedUrls.push(p.url); appliedSlots.push(posterSlot(p)) }
      else if (res.skipped) skipped++
      else { failed++; lastError = res.error }
    } catch (err) { failed++; lastError = err instanceof Error ? err.message : String(err) }
    onProgress(done, list.length)
  }
  return { done, failed, skipped, total: list.length, appliedUrls, appliedSlots, lastError }
}
